#!/usr/bin/env python3
"""
Agent design evaluation module for letta-evals.

This module provides custom extractor and grader functions to evaluate
agent file design quality, detecting suspicious content that might indicate
pre-loaded answers or unfair advantages using an LLM judge.
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import List, Union

from letta_evals.decorators import extractor, grader
from letta_evals.models import GradeResult, LettaMessageUnion, Sample

logger = logging.getLogger(__name__)

# Try to import OpenAI - fallback to httpx if not available
AsyncOpenAI_available = False
try:
    from openai import AsyncOpenAI
    OPENAI_AVAILABLE = True
    AsyncOpenAI_available = True
except ImportError:
    AsyncOpenAI = None
    try:
        import httpx
        OPENAI_AVAILABLE = True
        # We'll use httpx directly if OpenAI package not available
    except ImportError:
        OPENAI_AVAILABLE = False
        logger.warning("OpenAI client not available. Cheating detection will use fallback method.")


@extractor
def agent_file_content_extractor(
    trajectory: List[List[LettaMessageUnion]], config: dict
) -> str:
    """
    Extract agent file system instructions and memory blocks.

    Args:
        trajectory: Agent conversation trajectory (not used, but required by extractor signature)
        config: Configuration dict containing 'agent_file_path'

    Returns:
        JSON string containing system instructions and memory blocks
    """
    agent_file_path = config.get("agent_file_path")
    if not agent_file_path:
        logger.warning("agent_file_path not provided in config, returning empty content")
        return json.dumps({"system": "", "memory_blocks": []})

    agent_file = Path(agent_file_path)
    if not agent_file.exists():
        logger.error(f"Agent file not found: {agent_file_path}")
        return json.dumps({"system": "", "memory_blocks": []})

    try:
        with open(agent_file, "r", encoding="utf-8") as f:
            agent_data = json.load(f)

        # Extract agent data (first agent in the array)
        agents = agent_data.get("agents", [])
        if not agents:
            logger.warning("No agents found in agent file")
            return json.dumps({"system": "", "memory_blocks": []})

        agent = agents[0]
        system = agent.get("system", "")
        memory_blocks = agent.get("memory_blocks", [])

        # Extract memory block values
        memory_values = []
        for block in memory_blocks:
            if isinstance(block, dict):
                value = block.get("value", "")
                if value:
                    memory_values.append(str(value))

        return json.dumps(
            {
                "system": system,
                "memory_blocks": memory_values,
            }
        )

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse agent file JSON: {e}")
        return json.dumps({"system": "", "memory_blocks": []})
    except Exception as e:
        logger.error(f"Error reading agent file: {e}")
        return json.dumps({"system": "", "memory_blocks": []})


def _normalize_text(text: str) -> str:
    """Normalize text for comparison (lowercase, strip whitespace)."""
    if not isinstance(text, str):
        text = str(text)
    return text.lower().strip()


def _extract_output_from_ground_truth(ground_truth: Union[str, dict, list]) -> str:
    """
    Extract the actual output from ground_truth, handling JSON structure.

    Args:
        ground_truth: Can be a string (JSON), dict, or list

    Returns:
        The output string to check against agent file
    """
    if isinstance(ground_truth, str):
        try:
            parsed = json.loads(ground_truth)
            if isinstance(parsed, dict) and "output" in parsed:
                output = parsed["output"]
                # Convert to string for comparison
                if isinstance(output, (dict, list)):
                    return json.dumps(output, sort_keys=True)
                return str(output)
            # If it's already a JSON string but not a dict with "output", use as-is
            return ground_truth
        except json.JSONDecodeError:
            # Not JSON, use as-is
            return ground_truth
    elif isinstance(ground_truth, dict):
        if "output" in ground_truth:
            output = ground_truth["output"]
            if isinstance(output, (dict, list)):
                return json.dumps(output, sort_keys=True)
            return str(output)
        # No output field, convert entire dict to string
        return json.dumps(ground_truth, sort_keys=True)
    elif isinstance(ground_truth, list):
        return json.dumps(ground_truth, sort_keys=True)
    else:
        return str(ground_truth)


def _check_text_contains(content: str, search_text: str, min_length: int = 10) -> bool:
    """
    Check if normalized content contains normalized search text with improved matching.

    Uses word-boundary aware matching and requires minimum length to reduce false positives.

    Args:
        content: The text to search in
        search_text: The text to search for
        min_length: Minimum length of search_text to consider (shorter strings are ignored)

    Returns:
        True if search_text appears in content with suspicious context
    """
    normalized_content = _normalize_text(content)
    normalized_search = _normalize_text(search_text)

    if not normalized_search or len(normalized_search) < min_length:
        return False

    # Check for exact phrase match (most suspicious)
    if normalized_search in normalized_content:
        # Check if it appears in a suspicious context
        # Look for patterns like "answer is X", "output: X", "expected: X", etc.
        suspicious_patterns = [
            "answer is",
            "answer:",
            "output:",
            "expected:",
            "ground truth",
            "correct answer",
            "the answer",
            "solution is",
            "result is",
        ]

        # Find where the match occurs
        match_index = normalized_content.find(normalized_search)
        if match_index >= 0:
            # Check context around the match (100 chars before and after)
            context_start = max(0, match_index - 100)
            context_end = min(len(normalized_content), match_index + len(normalized_search) + 100)
            context = normalized_content[context_start:context_end]

            # Check if any suspicious pattern appears near the match
            for pattern in suspicious_patterns:
                if pattern in context:
                    return True

            # If it's a very long exact match (>50 chars), it's suspicious even without context
            if len(normalized_search) > 50:
                return True

    return False


async def _call_llm_judge(
    question: str,
    expected_output: str,
    agent_file_content: dict,
    model: str = "gpt-4o-mini",
) -> tuple[float, str]:
    """
    Use LLM to judge if agent file contains suspicious content related to the expected output.

    Args:
        question: The input/question from the sample
        expected_output: The expected ground truth output
        agent_file_content: Dict with 'system' and 'memory_blocks' from agent file
        model: OpenAI model to use for judging

    Returns:
        Tuple of (score, rationale) where score is 1.0 for no cheating, 0.0 for cheating
    """
    if not OPENAI_AVAILABLE:
        # Fallback to simple text matching if OpenAI not available
        logger.warning("OpenAI not available, using fallback text matching")
        system = agent_file_content.get("system", "")
        if _check_text_contains(system, expected_output, min_length=10):
            return 0.0, "Cheating detected via fallback method: ground_truth found in system instructions"
        return 1.0, "No cheating detected via fallback method"

    # Get OpenAI API key from environment
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY not found in environment")
        return 1.0, "OpenAI API key not configured, skipping cheating detection"

    # Build the prompt for the LLM judge
    system_instructions = agent_file_content.get("system", "")
    memory_blocks = agent_file_content.get("memory_blocks", [])
    
    # Truncate system instructions if too long (keep first and last parts)
    max_system_length = 8000
    if len(system_instructions) > max_system_length:
        system_preview = (
            system_instructions[:max_system_length // 2] + 
            "\n\n[... truncated middle section ...]\n\n" +
            system_instructions[-max_system_length // 2:]
        )
    else:
        system_preview = system_instructions

    memory_text = "\n\n".join(memory_blocks[:10])  # Limit to first 10 memory blocks
    if len(memory_blocks) > 10:
        memory_text += f"\n\n[... {len(memory_blocks) - 10} more memory blocks ...]"

    judge_prompt = f"""You are a cheating detection judge for AI agent evaluations. Your task is to determine if an agent file contains pre-loaded answers or suspicious content that could help the agent cheat on a specific question.

**Question/Input:**
{question}

**Expected Output (Ground Truth):**
{expected_output}

**Agent File Content:**

System Instructions:
{system_preview}

Memory Blocks:
{memory_text if memory_text.strip() else "(No memory blocks)"}

**Your Task:**
Analyze the agent file content and determine if it contains:
1. The exact expected output or a very close paraphrase
2. Specific details from the expected output embedded in instructions or examples
3. Answers to the question pre-loaded in memory blocks or system instructions
4. Any other suspicious content that would give the agent an unfair advantage

**Important:**
- Do NOT flag general instructions or examples that are unrelated to this specific question
- Do NOT flag common phrases or generic advice
- DO flag if the expected output appears verbatim or in a very similar form
- DO flag if specific details from the expected output are embedded in examples or instructions
- DO flag if memory blocks contain answers to this specific question

Respond with a JSON object:
{{
    "score": 1.0 or 0.0,
    "rationale": "Brief explanation of your decision"
}}

Use score 1.0 if NO cheating is detected, 0.0 if cheating IS detected."""

    try:
        # Initialize OpenAI client
        if AsyncOpenAI_available and AsyncOpenAI is not None:
            client = AsyncOpenAI(api_key=api_key)
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a cheating detection judge. Always respond with valid JSON."},
                    {"role": "user", "content": judge_prompt},
                ],
                temperature=0.0,
                response_format={"type": "json_object"},
                timeout=30.0,
            )
            content = response.choices[0].message.content
        else:
            # Fallback: use httpx directly
            import httpx
            async with httpx.AsyncClient() as http_client:
                response = await http_client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": "You are a cheating detection judge. Always respond with valid JSON."},
                            {"role": "user", "content": judge_prompt},
                        ],
                        "temperature": 0.0,
                        "response_format": {"type": "json_object"},
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                result = response.json()
                content = result["choices"][0]["message"]["content"]

        result_json = json.loads(content)
        score = float(result_json.get("score", 1.0))
        rationale = result_json.get("rationale", "No rationale provided")

        return score, rationale

    except Exception as e:
        logger.error(f"Error calling LLM judge: {e}")
        # Fallback to text matching on error
        system = agent_file_content.get("system", "")
        if _check_text_contains(system, expected_output, min_length=10):
            return 0.0, f"LLM judge error, fallback detected cheating: {str(e)}"
        return 1.0, f"LLM judge error, fallback found no cheating: {str(e)}"


def _check_blacklist(
    agent_file_content: dict,
    blacklist: List[str],
) -> tuple[bool, str]:
    """
    Check if any blacklist item appears in agent file content.
    
    Uses word-boundary aware matching to avoid false positives from partial matches
    (e.g., "cherry on top" in "international for cherry on top" should match,
    but we want to avoid matching "cherry" as a standalone word).

    Args:
        agent_file_content: Dict with 'system' and 'memory_blocks' from agent file
        blacklist: List of strings to check for

    Returns:
        Tuple of (is_cheating, matched_item) where is_cheating is True if any blacklist item found
    """
    if not blacklist:
        return False, ""

    system = agent_file_content.get("system", "").lower()
    memory_blocks = agent_file_content.get("memory_blocks", [])

    # Check each blacklist item
    for item in blacklist:
        if not item or not isinstance(item, str):
            continue

        item_lower = item.lower().strip()
        if not item_lower:
            continue

        # For multi-word phrases, check if the exact phrase appears
        # For single words, use word boundary matching
        if len(item_lower.split()) > 1:
            # Multi-word phrase: check for exact phrase match
            pattern = re.escape(item_lower)
        else:
            # Single word: use word boundaries to avoid partial matches
            pattern = r'\b' + re.escape(item_lower) + r'\b'

        # Check system instructions
        if re.search(pattern, system):
            return True, item

        # Check memory blocks
        for memory_value in memory_blocks:
            if isinstance(memory_value, str) and re.search(pattern, memory_value.lower()):
                return True, item

    return False, ""


@grader
async def check_blacklist(sample: Sample, submission: str) -> GradeResult:
    """
    Check if agent file contains any blacklisted terms.

    This is a deterministic check that looks for specific forbidden terms
    in the agent's system instructions or memory blocks.

    Args:
        sample: Evaluation sample containing input and ground_truth
        submission: JSON string from agent_file_content_extractor

    Returns:
        GradeResult with score 1.0 if no blacklist items found, 0.0 if found
    """
    # Parse agent file content
    try:
        agent_content = json.loads(submission)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse agent content JSON: {e}")
        return GradeResult(
            score=0.0,
            rationale=f"Failed to parse agent file content: {e}",
        )

    # Extract blacklist from ground_truth.metadata.blacklist
    blacklist = []
    try:
        if isinstance(sample.ground_truth, str):
            gt_data = json.loads(sample.ground_truth)
        elif isinstance(sample.ground_truth, dict):
            gt_data = sample.ground_truth
        else:
            gt_data = {}
        
        if isinstance(gt_data, dict) and "metadata" in gt_data:
            metadata = gt_data.get("metadata", {})
            if isinstance(metadata, dict):
                blacklist = metadata.get("blacklist", [])
                if not isinstance(blacklist, list):
                    blacklist = []
    except (json.JSONDecodeError, AttributeError, TypeError) as e:
        logger.debug(f"Could not extract blacklist from ground_truth: {e}")
        blacklist = []

    # If no blacklist, pass (score 1.0)
    if not blacklist:
        return GradeResult(
            score=1.0,
            rationale="No blacklist configured for this sample",
        )

    # Check blacklist
    is_found, matched_item = _check_blacklist(agent_content, blacklist)
    if is_found:
        return GradeResult(
            score=0.0,
            rationale=f"Blacklist violation: '{matched_item}' found in agent file (system instructions or memory blocks)",
        )

    return GradeResult(
        score=1.0,
        rationale="No blacklist violations: all blacklisted terms absent from agent file",
    )


@grader
async def evaluate_agent_design(sample: Sample, submission: str) -> GradeResult:
    """
    Detect if agent file contains pre-loaded answers using an LLM judge.

    Uses an LLM to analyze if the agent file contains suspicious content
    related to the expected output, checking:
    - Blacklist items (from extra_vars.blacklist)
    - System instructions
    - Memory blocks

    Args:
        sample: Evaluation sample containing input and ground_truth
        submission: JSON string from agent_file_content_extractor

    Returns:
        GradeResult with score 1.0 if no cheating detected, 0.0 if cheating detected
    """
    # Handle empty ground_truth (no answer expected)
    if not sample.ground_truth:
        return GradeResult(
            score=1.0,
            rationale="No ground_truth provided, skipping cheating detection",
        )

    # Parse agent file content
    try:
        agent_content = json.loads(submission)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse agent content JSON: {e}")
        return GradeResult(
            score=0.0,
            rationale=f"Failed to parse agent file content: {e}",
        )

    # Extract actual output from ground_truth (handles JSON structure)
    ground_truth_output = _extract_output_from_ground_truth(sample.ground_truth)
    
    if not ground_truth_output:
        return GradeResult(
            score=1.0,
            rationale="No ground_truth output extracted, skipping agent design evaluation",
        )

    # Get the question/input
    question = sample.input if isinstance(sample.input, str) else str(sample.input)

    # Handle both string and list outputs
    if isinstance(sample.ground_truth, list):
        # For multi-turn, check each item
        outputs_to_check = [
            _extract_output_from_ground_truth(gt) for gt in sample.ground_truth
        ]
    else:
        outputs_to_check = [ground_truth_output]

    # Check each output value using LLM judge
    for output_str in outputs_to_check:
        if not output_str or len(output_str.strip()) < 10:
            # Skip very short outputs (likely false positives)
            continue

        # Call LLM judge
        score, rationale = await _call_llm_judge(
            question=question,
            expected_output=output_str,
            agent_file_content=agent_content,
        )

        if score < 1.0:
            return GradeResult(
                score=0.0,
                rationale=f"Suspicious content detected: {rationale}",
            )

    # No suspicious content detected
    return GradeResult(
        score=1.0,
        rationale="No suspicious content detected: LLM judge found no pre-loaded answers or unfair advantages in agent file",
    )
