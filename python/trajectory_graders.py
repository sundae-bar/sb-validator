#!/usr/bin/env python3
"""
Trajectory-based evaluation module for letta-evals.

This module provides custom extractor and grader functions that evaluate
the agent's step-by-step reasoning process (tool calls, file accesses,
memory operations) rather than just the final answer.

Graders:
  - check_file_access: Gate that fails if agent answers company_files
    questions without actually accessing files
  - evaluate_reasoning_quality: LLM judge that scores the quality of
    the agent's tool usage and reasoning steps
"""

import json
import logging
import os
from pathlib import Path
from typing import List, Union

from letta_evals.decorators import extractor, grader
from letta_evals.models import GradeResult, LettaMessageUnion, Sample

logger = logging.getLogger(__name__)

# File access tools — the tools an agent uses to read company data
FILE_ACCESS_TOOLS = {"grep_files", "open_files", "semantic_search_files"}

# Memory tools
MEMORY_TOOLS = {"memory_insert", "memory_replace", "memory_rethink", "memory", "core_memory_append", "core_memory_replace"}

# Try to import OpenAI for LLM judge
try:
    from openai import AsyncOpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    AsyncOpenAI = None
    try:
        import httpx
        OPENAI_AVAILABLE = True
    except ImportError:
        OPENAI_AVAILABLE = False
        logger.warning("OpenAI client not available. Reasoning quality grader will use fallback.")


def _extract_tool_call_info(message: dict) -> dict:
    """Extract tool call name and arguments from a tool_call_message."""
    tool_call = message.get("tool_call", {})
    if not isinstance(tool_call, dict):
        return {"name": "unknown", "arguments": {}}

    name = tool_call.get("name", "unknown")
    args_raw = tool_call.get("arguments", {})

    # Arguments may be a string (JSON) or dict
    if isinstance(args_raw, str):
        try:
            args = json.loads(args_raw)
        except (json.JSONDecodeError, TypeError):
            args = {"raw": args_raw[:200]}
    elif isinstance(args_raw, dict):
        args = args_raw
    else:
        args = {}

    return {"name": name, "arguments": args}


def _extract_files_from_tool_call(tool_info: dict) -> List[str]:
    """Extract filenames from a file access tool call's arguments."""
    files = []
    args = tool_info.get("arguments", {})

    # open_files: file_requests is a list of {file_name: ...}
    if tool_info["name"] == "open_files":
        requests = args.get("file_requests", [])
        if isinstance(requests, list):
            for req in requests:
                if isinstance(req, dict) and "file_name" in req:
                    files.append(req["file_name"])

    # grep_files: include param may have filename patterns
    elif tool_info["name"] == "grep_files":
        include = args.get("include", "")
        if include:
            files.append(include)
        # Also check pattern for filename references
        pattern = args.get("pattern", "")
        if pattern:
            files.append(f"grep:{pattern}")

    # semantic_search_files: query may reference files
    elif tool_info["name"] == "semantic_search_files":
        query = args.get("query", "")
        if query:
            files.append(f"search:{query[:100]}")

    return files


def _extract_message_text(message: dict) -> str:
    """Extract text content from a message."""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for part in content:
            if isinstance(part, dict) and "text" in part:
                texts.append(part["text"])
        return " ".join(texts)
    return ""


def _parse_agent_file(config: dict) -> dict:
    """
    Parse the agent .af file to extract pre-loaded content.

    Returns a dict with system prompt and memory block summaries,
    or empty values if the file is not available.
    """
    agent_file_path = config.get("agent_file_path")
    if not agent_file_path:
        return {"system": "", "memory_blocks": []}

    agent_file = Path(agent_file_path)
    if not agent_file.exists():
        return {"system": "", "memory_blocks": []}

    try:
        with open(agent_file, "r", encoding="utf-8") as f:
            agent_data = json.load(f)

        agents = agent_data.get("agents", [])
        if not agents:
            return {"system": "", "memory_blocks": []}

        agent = agents[0]
        system = agent.get("system", "")

        # Resolve memory blocks (same logic as agent_file_content_extractor)
        root_blocks = {
            block.get("id"): block
            for block in agent_data.get("blocks", [])
            if isinstance(block, dict) and block.get("id")
        }
        resolved_blocks = []
        for block_id in agent.get("block_ids", []) or []:
            block = root_blocks.get(block_id)
            if block:
                resolved_blocks.append(block)

        inline_memory_blocks = agent.get("memory_blocks", [])
        if not resolved_blocks and isinstance(inline_memory_blocks, list):
            resolved_blocks = [
                block for block in inline_memory_blocks if isinstance(block, dict)
            ]

        block_summaries = []
        for block in resolved_blocks:
            label = block.get("label", "unknown")
            value = str(block.get("value", ""))
            if value:
                full_length = len(value)

                # Scan the full block for suspicious company-specific content
                # rather than truncating to a fixed window (which gamers can dodge
                # by front-loading innocent content).
                suspicious_markers = []
                value_lower = value.lower()

                # Check for dollar amounts
                import re
                dollar_amounts = re.findall(r'\$[\d,]+(?:\.\d{2})?', value)
                if dollar_amounts:
                    suspicious_markers.append(f"Dollar amounts found: {', '.join(dollar_amounts[:10])}")

                # Check for proper nouns (capitalized multi-word phrases likely = employee names)
                proper_nouns = re.findall(r'[A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?', value)
                # Filter out common non-name patterns
                names = [n for n in proper_nouns if n.lower() not in {
                    "cherry on top", "new year", "good friday", "boxing day",
                    "canada day", "labour day", "christmas day",
                }]
                if names:
                    unique_names = list(dict.fromkeys(names))[:15]
                    suspicious_markers.append(f"Proper nouns: {', '.join(unique_names)}")

                # Check for specific policy keywords that suggest pre-loaded heuristics
                policy_keywords = [
                    "approval chain", "escalation", "sla credit", "accrual rate",
                    "blackout period", "per diem", "lodging cap", "hotel cap",
                    "department head", "self-approval", "conflict of interest",
                ]
                found_keywords = [kw for kw in policy_keywords if kw in value_lower]
                if found_keywords:
                    suspicious_markers.append(f"Policy keywords: {', '.join(found_keywords)}")

                # Check for structured data patterns (decision trees, if/then rules)
                if any(pattern in value_lower for pattern in [
                    "if ", "then ", "→", "->", "gate-", "tier ", "bracket",
                ]):
                    # Count how many rule-like patterns exist
                    rule_count = value_lower.count("if ") + value_lower.count("→") + value_lower.count("->")
                    if rule_count > 2:
                        suspicious_markers.append(f"Rule-like patterns: {rule_count} instances")

                block_summaries.append({
                    "label": label,
                    "content_preview": value[:200] + ("..." if full_length > 200 else ""),
                    "length": full_length,
                    "suspicious_content": suspicious_markers,
                })

        return {
            "system": system[:1000],  # First 1000 chars of system prompt
            "memory_blocks": block_summaries,
        }
    except Exception as e:
        logger.error(f"Error parsing agent file: {e}")
        return {"system": "", "memory_blocks": []}


@extractor
def trajectory_extractor(
    trajectory: List[List[LettaMessageUnion]], config: dict
) -> str:
    """
    Extract a structured summary of the agent's trajectory AND pre-loaded agent content.

    Combines two sources of information:
    1. Trajectory: tool calls, file accesses, memory operations, reasoning steps
    2. Agent file: system prompt and memory blocks (to detect pre-loaded knowledge)

    This lets the reasoning judge compare what the agent had pre-loaded
    vs what it looked up vs what it answered — catching fake lookups.

    Args:
        trajectory: Agent conversation trajectory (list of turns, each a list of messages)
        config: Configuration dict containing 'agent_file_path'

    Returns:
        JSON string with trajectory summary + agent pre-loaded content
    """
    tool_calls = []
    files_accessed = []
    memory_operations = []
    reasoning_steps = []
    assistant_messages = []
    tool_returns = []

    for turn in trajectory:
        for message in turn:
            if not isinstance(message, dict):
                # Handle pydantic model objects
                try:
                    message = message.model_dump() if hasattr(message, "model_dump") else message.__dict__
                except Exception:
                    continue

            msg_type = message.get("message_type", "")

            if msg_type == "tool_call_message":
                tool_info = _extract_tool_call_info(message)
                tool_calls.append({
                    "name": tool_info["name"],
                    "arguments_summary": json.dumps(tool_info["arguments"])[:200],
                })

                # Track file accesses
                if tool_info["name"] in FILE_ACCESS_TOOLS:
                    extracted_files = _extract_files_from_tool_call(tool_info)
                    files_accessed.extend(extracted_files)

                # Track memory operations
                if tool_info["name"] in MEMORY_TOOLS:
                    memory_operations.append({
                        "tool": tool_info["name"],
                        "summary": json.dumps(tool_info["arguments"])[:150],
                    })

            elif msg_type == "tool_return_message":
                ret = message.get("tool_return", "")
                if isinstance(ret, str):
                    tool_returns.append(ret[:200])

            elif msg_type == "reasoning_message":
                text = _extract_message_text(message)
                if text:
                    reasoning_steps.append(text[:300])

            elif msg_type == "assistant_message":
                text = _extract_message_text(message)
                if text:
                    assistant_messages.append(text[:500])

    # Parse agent file for pre-loaded content
    agent_content = _parse_agent_file(config)

    summary = {
        "tool_calls": tool_calls,
        "files_accessed": list(set(files_accessed)),
        "memory_operations": memory_operations,
        "reasoning_steps": reasoning_steps,
        "tool_returns": tool_returns,
        "step_count": len(tool_calls),
        "has_file_lookup": len(files_accessed) > 0,
        "file_tool_count": sum(1 for tc in tool_calls if tc["name"] in FILE_ACCESS_TOOLS),
        "memory_tool_count": len(memory_operations),
        "agent_preloaded": agent_content,
    }

    return json.dumps(summary)


def _get_context_scope(sample: Sample) -> str:
    """Extract context_scope from sample's ground_truth metadata."""
    try:
        gt = sample.ground_truth
        if isinstance(gt, str):
            gt = json.loads(gt)
        if isinstance(gt, dict):
            metadata = gt.get("metadata", {})
            if isinstance(metadata, dict):
                return metadata.get("context_scope", "unknown")
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return "unknown"


def _get_metadata_field(sample: Sample, field: str, default=None):
    """Extract a field from sample's ground_truth metadata."""
    try:
        gt = sample.ground_truth
        if isinstance(gt, str):
            gt = json.loads(gt)
        if isinstance(gt, dict):
            metadata = gt.get("metadata", {})
            if isinstance(metadata, dict):
                return metadata.get(field, default)
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return default


@grader
async def check_file_access(sample: Sample, submission: str) -> GradeResult:
    """
    Gate grader: checks if the agent accessed files for company_files tests.

    For tests that require company file data (context_scope: "company_files"),
    verifies the agent actually called file access tools before answering.
    Agents that answer without looking up files are likely reciting from
    pre-loaded memory.

    Args:
        sample: Evaluation sample with ground_truth metadata
        submission: JSON string from trajectory_extractor

    Returns:
        GradeResult with score 1.0 (pass) or 0.0 (fail)
    """
    context_scope = _get_context_scope(sample)

    # Input-only tests don't need file access — auto pass
    if context_scope != "company_files":
        return GradeResult(
            score=1.0,
            rationale=f"Test context_scope is '{context_scope}', file access not required",
        )

    # Parse trajectory summary
    try:
        summary = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(
            score=1.0,
            rationale="Could not parse trajectory summary, passing by default",
        )

    has_file_lookup = summary.get("has_file_lookup", False)
    file_tool_count = summary.get("file_tool_count", 0)
    files_accessed = summary.get("files_accessed", [])

    if not has_file_lookup:
        return GradeResult(
            score=0.0,
            rationale=(
                f"Agent answered a company_files question without accessing any files. "
                f"Tool calls: {summary.get('step_count', 0)}, file tools: 0. "
                f"This suggests the agent is reciting from pre-loaded memory."
            ),
        )

    # Check required_files if specified
    required_files = _get_metadata_field(sample, "required_files", default=[])
    if required_files and isinstance(required_files, list):
        files_str = " ".join(files_accessed).lower()
        missing = [f for f in required_files if f.lower() not in files_str]
        if missing:
            return GradeResult(
                score=0.0,
                rationale=(
                    f"Agent accessed some files but missed required files: {missing}. "
                    f"Files accessed: {files_accessed}"
                ),
            )

    return GradeResult(
        score=1.0,
        rationale=f"Agent accessed {file_tool_count} file(s) before answering: {files_accessed}",
    )


@grader
async def check_memory_usage(sample: Sample, submission: str) -> GradeResult:
    """
    Gate grader: checks if the agent used memory tools when the test requires it.

    Tests that ask agents to save/record/store information should use memory_insert
    or similar tools. If the test has a 'tool_confirmation' rubric category or a
    penalty for not using the memory tool, this grader enforces it deterministically.

    Args:
        sample: Evaluation sample with ground_truth metadata
        submission: JSON string from trajectory_extractor

    Returns:
        GradeResult with score 1.0 (pass) or 0.0 (fail)
    """
    # Check if this test requires memory tool usage
    requires_memory = False

    # Method 1: Check for tool_confirmation in rubric
    rubric = _get_metadata_field(sample, "rubric", default={})
    if isinstance(rubric, dict) and "tool_confirmation" in rubric:
        requires_memory = True

    # Method 2: Check for memory-related penalty
    penalties = _get_metadata_field(sample, "penalties", default=[])
    if isinstance(penalties, list):
        for p in penalties:
            if isinstance(p, str) and "memory tool" in p.lower():
                requires_memory = True
                break

    if not requires_memory:
        return GradeResult(
            score=1.0,
            rationale="Test does not require memory tool usage",
        )

    # Parse trajectory summary
    try:
        summary = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(
            score=1.0,
            rationale="Could not parse trajectory summary, passing by default",
        )

    memory_tool_count = summary.get("memory_tool_count", 0)

    if memory_tool_count == 0:
        return GradeResult(
            score=0.0,
            rationale=(
                f"Test requires using the memory tool to save information, "
                f"but agent made 0 memory tool calls. "
                f"Tools used: {[tc['name'] for tc in summary.get('tool_calls', [])]}"
            ),
        )

    return GradeResult(
        score=1.0,
        rationale=f"Agent used memory tools {memory_tool_count} time(s) as required",
    )


async def _call_reasoning_judge(
    question: str,
    trajectory_summary: dict,
    reasoning_criteria: str = "",
    model: str = "gpt-5.1",
) -> tuple[float, str]:
    """
    Use LLM to judge the quality of the agent's reasoning steps.

    Args:
        question: The input question
        trajectory_summary: Structured trajectory from extractor
        reasoning_criteria: Optional test-specific criteria
        model: OpenAI model to use

    Returns:
        Tuple of (score 0.0-1.0, rationale)
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key or not OPENAI_AVAILABLE:
        # Fallback: simple heuristic scoring
        score = 0.5
        if trajectory_summary.get("has_file_lookup"):
            score += 0.2
        if trajectory_summary.get("memory_tool_count", 0) > 0:
            score += 0.1
        if trajectory_summary.get("step_count", 0) > 1:
            score += 0.1
        if trajectory_summary.get("reasoning_steps"):
            score += 0.1
        return min(score, 1.0), "Scored via fallback heuristic (no OpenAI available)"

    # Build step-by-step trace for the judge
    steps_text = ""
    for i, tc in enumerate(trajectory_summary.get("tool_calls", [])):
        steps_text += f"Step {i+1}: Called {tc['name']}({tc['arguments_summary']})\n"

    # Include tool returns so the judge can see what the agent actually retrieved
    returns_text = ""
    tool_returns = trajectory_summary.get("tool_returns", [])
    if tool_returns:
        returns_text = "\nTool return values (what the agent received back):\n"
        for i, ret in enumerate(tool_returns):
            returns_text += f"  Return {i+1}: {ret}\n"

    if trajectory_summary.get("reasoning_steps"):
        steps_text += "\nAgent reasoning:\n"
        for r in trajectory_summary["reasoning_steps"]:
            steps_text += f"  - {r}\n"

    # Build pre-loaded content section from full-block scan
    preloaded_text = ""
    agent_preloaded = trajectory_summary.get("agent_preloaded", {})
    memory_blocks = agent_preloaded.get("memory_blocks", [])
    if memory_blocks:
        preloaded_text = "\n**Agent's pre-loaded memory blocks** (content stored in the agent file BEFORE the test):\n"
        for block in memory_blocks:
            label = block.get("label", "unknown")
            preview = block.get("content_preview", block.get("content", ""))
            length = block.get("length", 0)
            suspicious = block.get("suspicious_content", [])

            preloaded_text += f"\n  [{label}] ({length} chars):\n"
            preloaded_text += f"    Preview: {preview}\n"
            if suspicious:
                preloaded_text += f"    SUSPICIOUS CONTENT DETECTED:\n"
                for flag in suspicious:
                    preloaded_text += f"      - {flag}\n"
            else:
                preloaded_text += f"    No suspicious content detected.\n"
    else:
        preloaded_text = "\n**Agent's pre-loaded memory blocks:** (none or empty)\n"

    criteria_section = ""
    if reasoning_criteria:
        criteria_section = f"""
**Test-specific criteria:**
{reasoning_criteria}
"""

    judge_prompt = f"""You are evaluating the quality of an AI agent's reasoning process. You will see:
1. The question asked
2. The agent's step-by-step tool usage
3. What the tools returned to the agent
4. What the agent had PRE-LOADED in its memory blocks before the test

Your job is to determine whether the agent genuinely used its tools to find information, or whether it already had the answer pre-loaded and only did a superficial lookup to appear genuine.

**Question:**
{question}

**Agent's step-by-step process:**
{steps_text if steps_text.strip() else "(No tool calls — agent answered directly without using any tools)"}
{returns_text}
**File access:** {"Yes" if trajectory_summary.get("has_file_lookup") else "No"} ({trajectory_summary.get("file_tool_count", 0)} file tools used)
**Memory operations:** {trajectory_summary.get("memory_tool_count", 0)}
**Total steps:** {trajectory_summary.get("step_count", 0)}
{preloaded_text}
{criteria_section}
**Scoring criteria (evaluate each 0.0-1.0):**
1. **Information gathering** (0.25): Did the agent look up relevant information before answering? Using file tools (grep_files, open_files, semantic_search_files) to find data is good. Answering without looking anything up is poor unless the question is self-contained.
2. **Tool appropriateness** (0.25): Did the agent use the right tools? grep_files for specific text, semantic_search for conceptual queries, open_files for full document review.
3. **Genuine reasoning** (0.25): Did the agent actually USE information from its tool lookups to form its answer? Or did it already have the answer pre-loaded in memory blocks and only did a superficial/perfunctory lookup? If the agent's memory blocks contain company-specific facts (names, dollar amounts, policy details) that match its answer, and the tool returns don't contain those facts, score this LOW — the agent is faking its reasoning.
4. **Efficiency** (0.25): Did the agent avoid unnecessary steps? Redundant searches or excessive tool calls reduce this score.

Respond with JSON:
{{
    "information_gathering": 0.0-1.0,
    "tool_appropriateness": 0.0-1.0,
    "genuine_reasoning": 0.0-1.0,
    "efficiency": 0.0-1.0,
    "rationale": "Brief explanation"
}}"""

    try:
        if AsyncOpenAI is not None:
            client = AsyncOpenAI(api_key=api_key)
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a reasoning quality judge. Always respond with valid JSON."},
                    {"role": "user", "content": judge_prompt},
                ],
                temperature=0.0,
                response_format={"type": "json_object"},
                timeout=30.0,
            )
            content = response.choices[0].message.content
        else:
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
                            {"role": "system", "content": "You are a reasoning quality judge. Always respond with valid JSON."},
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
        scores = [
            float(result_json.get("information_gathering", 0.5)),
            float(result_json.get("tool_appropriateness", 0.5)),
            float(result_json.get("genuine_reasoning", 0.5)),
            float(result_json.get("efficiency", 0.5)),
        ]
        avg_score = sum(scores) / len(scores)
        rationale = result_json.get("rationale", "No rationale provided")

        return round(avg_score, 5), rationale

    except Exception as e:
        logger.error(f"Error calling reasoning judge: {e}")
        return 0.5, f"Reasoning judge error, using default score: {str(e)}"


@grader
async def evaluate_reasoning_quality(sample: Sample, submission: str) -> GradeResult:
    """
    LLM judge grader: evaluates the quality of the agent's reasoning steps.

    Scores the agent's tool usage, information gathering, and logical
    step sequence on a 0.0-1.0 scale.

    Args:
        sample: Evaluation sample containing input and ground_truth
        submission: JSON string from trajectory_extractor

    Returns:
        GradeResult with score 0.0-1.0
    """
    # Parse trajectory summary
    try:
        summary = json.loads(submission)
    except json.JSONDecodeError:
        return GradeResult(
            score=0.5,
            rationale="Could not parse trajectory summary, using default score",
        )

    # Get the question
    question = sample.input if isinstance(sample.input, str) else str(sample.input)

    # Get optional reasoning criteria from metadata
    reasoning_criteria = _get_metadata_field(sample, "reasoning_criteria", default="")

    # Call the LLM judge
    score, rationale = await _call_reasoning_judge(
        question=question,
        trajectory_summary=summary,
        reasoning_criteria=reasoning_criteria,
    )

    return GradeResult(score=score, rationale=rationale)
