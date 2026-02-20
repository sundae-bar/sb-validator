#!/usr/bin/env python3
"""
Wrapper script that runs letta-evals with max_steps injection.

This script replaces LettaAgentTarget.run() to use MAX_STEPS from environment
instead of the hardcoded max_steps=100.
"""

import os
import sys
from typing import Optional

# Read MAX_STEPS from environment, default to 10 if not set
MAX_STEPS_ENV = os.getenv('MAX_STEPS')
MAX_STEPS = 10  # Default value

if MAX_STEPS_ENV:
    try:
        MAX_STEPS = int(MAX_STEPS_ENV)
    except ValueError:
        print(f"Warning: Invalid MAX_STEPS value '{MAX_STEPS_ENV}', using default {MAX_STEPS}", file=sys.stderr)

# Control debug output via environment variable
DEBUG_OUTPUT = os.getenv('LETTA_DEBUG', '').lower() in ('1', 'true', 'yes')

if DEBUG_OUTPUT:
    print(f"✓ max_steps={MAX_STEPS} configured for Letta API calls", file=sys.stderr)

# Fix argv so it looks like: ['letta-evals', 'run', 'suite.yaml', '--output', '...']
sys.argv[0] = 'letta-evals'

# Import letta_evals
from letta_evals.cli import app

# Replace LettaAgentTarget.run to use MAX_STEPS instead of hardcoded 100
try:
    from letta_evals.targets.letta_agent import LettaAgentTarget
    import anyio
    import httpx
    import logging
    from typing import Any, Awaitable, Callable, List
    
    # Import utils functions - copy the implementations if they don't exist
    try:
        from letta_evals.utils import consume_stream_with_resumes, list_all_run_messages
    except ImportError:
        # Copy the implementations from letta-evals/utils.py if not available
        
        async def list_all_run_messages(
            client: Any,
            run_id: str,
            *,
            page_limit: int = 200,
            max_attempts_per_page: int = 5,
            backoff_base_s: float = 0.5,
            backoff_max_s: float = 8.0,
        ) -> List[Any]:
            """List all messages for a run using pagination + retries."""
            messages: List[Any] = []
            after: Optional[str] = None
            while True:
                async def _list_page() -> Any:
                    kwargs = {"run_id": run_id, "limit": page_limit, "order": "asc"}
                    if after is not None:
                        kwargs["after"] = after
                    return await client.runs.messages.list(**kwargs)
                
                try:
                    page = await _list_page()
                except Exception as e:
                    if max_attempts_per_page > 0:
                        await anyio.sleep(backoff_base_s)
                        max_attempts_per_page -= 1
                        continue
                    raise
                
                items = getattr(page, "items", None) or []
                if not items:
                    break
                messages.extend(items)
                last_id = getattr(items[-1], "id", None)
                if not last_id or last_id == after:
                    break
                after = last_id
            return messages
        
        async def consume_stream_with_resumes(
            stream_iter: Any,
            *,
            resume_stream: Callable[[str, int], Awaitable[Any]],
            on_chunk: Optional[Callable[[Any], Awaitable[None]]] = None,
            max_resumes: int = 5,
            backoff_base_s: float = 0.5,
            backoff_max_s: float = 8.0,
            log: Optional[logging.Logger] = None,
            description: str = "stream",
        ) -> tuple[Optional[str], Optional[int]]:
            """Consume an SSE stream, resuming from seq_id on transient disconnects."""
            log = log or logging.getLogger(__name__)
            run_id: Optional[str] = None
            last_seq_id: Optional[int] = None
            
            async def _consume(single_iter: Any) -> None:
                nonlocal run_id, last_seq_id
                async for chunk in single_iter:
                    rid = getattr(chunk, "run_id", None)
                    if rid:
                        run_id = rid
                    if hasattr(chunk, "seq_id"):
                        last_seq_id = getattr(chunk, "seq_id")
                    if on_chunk is not None:
                        await on_chunk(chunk)
            
            resume_attempt = 0
            current_iter = stream_iter
            cancel_exc = anyio.get_cancelled_exc_class()
            
            while True:
                try:
                    await _consume(current_iter)
                    break
                except cancel_exc:
                    raise
                except RuntimeError:
                    raise
                except Exception as stream_err:
                    if not isinstance(stream_err, (httpx.HTTPError, httpx.HTTPStatusError)):
                        raise
                    if not (run_id and last_seq_id is not None):
                        raise
                    resume_attempt += 1
                    if resume_attempt > max_resumes:
                        raise
                    backoff_s = min(backoff_max_s, backoff_base_s * (2 ** (resume_attempt - 1)))
                    await anyio.sleep(backoff_s)
                    current_iter = await resume_stream(run_id, last_seq_id)
            
            return run_id, last_seq_id
    
    # Import other dependencies - handle missing imports gracefully
    try:
        from letta_evals.models import TargetResult
    except (ImportError, AttributeError):
        raise ImportError("TargetResult is required from letta_evals.models but not found")
    
    try:
        from letta_evals.visualization.base import ProgressCallback
    except (ImportError, AttributeError):
        raise ImportError("ProgressCallback is required from letta_evals.visualization.base but not found")
    
    from letta_client.types import MessageCreateParam
    
    # TargetError might not exist in all versions - try multiple import strategies
    TargetError = None
    try:
        from letta_evals.targets.base import TargetError
    except (ImportError, AttributeError):
        try:
            # Try importing the module and getting the attribute
            import letta_evals.targets.base as base_module
            TargetError = getattr(base_module, 'TargetError', None)
        except Exception:
            pass
    
    # If still not found, create a fallback
    if TargetError is None:
        class TargetError(Exception):
            def __init__(self, message: str, agent_id: Optional[str] = None):
                super().__init__(message)
                self.agent_id = agent_id
    
    # TurnTokenData might not exist in all versions - import with fallback
    try:
        from letta_evals.models import TurnTokenData
    except ImportError:
        # Define a simple fallback if it doesn't exist - match the actual structure
        from pydantic import BaseModel, Field
        from typing import Optional, List, Any
        class TurnTokenData(BaseModel):
            role: str = Field(description="Message role")
            content: Optional[str] = Field(default=None)
            output_ids: Optional[List[int]] = Field(default=None)
            output_token_logprobs: Optional[List[Any]] = Field(default=None)
    
    logger = logging.getLogger(__name__)
    
    if hasattr(LettaAgentTarget, 'run'):
        original_run = LettaAgentTarget.run
        
        async def patched_run(
            self,
            sample,
            progress_callback: Optional[ProgressCallback] = None,
            project_id: Optional[str] = None,
            retrieve_agent_state: bool = False,
            return_token_data: bool = False,
        ):
            """Run the agent on a sample with MAX_STEPS instead of hardcoded 100."""
            # Get timeout and max_retries with defaults if not set
            timeout = getattr(self, 'timeout', None)
            max_retries = getattr(self, 'max_retries', 0)
            
            attempt = 0
            last_error = None

            while attempt <= max_retries:
                agent_id = self.agent_id
                agent_id_to_cleanup = None

                try:
                    # Handle timeout - anyio.fail_after(None) means no timeout
                    if timeout is not None:
                        timeout_context = anyio.fail_after(timeout)
                    else:
                        # Create a no-op context manager for None timeout
                        from contextlib import nullcontext
                        timeout_context = nullcontext()
                    
                    with timeout_context:
                        folder_ids_from_file = []
                        
                        if self.agent_file:
                            # Read agent file to get folder_ids before importing
                            import json
                            with open(self.agent_file, "r", encoding="utf-8") as f:
                                agent_file_content = f.read()
                                try:
                                    agent_file_data = json.loads(agent_file_content)
                                    if agent_file_data.get("agents") and len(agent_file_data["agents"]) > 0:
                                        agent_schema = agent_file_data["agents"][0]
                                        folder_ids_from_file = agent_schema.get("folder_ids", []) or []
                                        if DEBUG_OUTPUT:
                                            print(f"DEBUG: Found folder_ids in agent file: {folder_ids_from_file}", file=sys.stderr)
                                except json.JSONDecodeError as e:
                                    print(f"WARNING: Failed to parse agent file JSON: {e}", file=sys.stderr)
                            
                            with open(self.agent_file, "rb") as f:
                                resp = await self.client.agents.import_file(
                                    file=f, append_copy_suffix=False, override_existing_tools=False, project_id=project_id
                                )
                                if len(resp.agent_ids) > 1:
                                    raise RuntimeError(
                                        f"Expected single agent from .af file, got {len(resp.agent_ids)} agents. We don't support multi-agent evals yet."
                                    )

                                agent_id = resp.agent_ids[0]
                                agent_id_to_cleanup = agent_id

                        elif self.agent_script:
                            from letta_evals.utils import load_object
                            agent_factory_func = load_object(self.agent_script, self.base_dir)
                            agent_id = await agent_factory_func(self.client, sample)
                            agent_id_to_cleanup = agent_id

                        if self.llm_config and agent_id:
                            llm_config_dict = self.llm_config.model_dump(by_alias=True, exclude_none=True)
                            await self.client.agents.update(agent_id=agent_id, llm_config=llm_config_dict)
                        elif self.model_handle and agent_id:
                            await self.client.agents.update(agent_id=agent_id, model=self.model_handle)

                        agent = await self.client.agents.retrieve(agent_id=agent_id, include=[])
                        
                        # Get folder_ids from agent object or from file
                        folder_ids = getattr(agent, 'folder_ids', None) or folder_ids_from_file or []
                        if DEBUG_OUTPUT:
                            print(f"DEBUG: Agent {agent_id} folder_ids from object: {getattr(agent, 'folder_ids', None)}, from file: {folder_ids_from_file}, final: {folder_ids}", file=sys.stderr)
                        
                        # Explicitly attach each folder to ensure files are attached
                        if folder_ids:
                            if DEBUG_OUTPUT:
                                print(f"DEBUG: Attaching {len(folder_ids)} folder(s) to agent {agent_id}", file=sys.stderr)
                            for folder_id in folder_ids:
                                try:
                                    # Attach folder to agent (this will attach files from the folder)
                                    await self.client.agents.folders.attach(folder_id=folder_id, agent_id=agent_id)
                                    if DEBUG_OUTPUT:
                                        print(f"DEBUG: Successfully attached folder {folder_id} to agent {agent_id}", file=sys.stderr)
                                except Exception as e:
                                    print(f"WARNING: Failed to attach folder {folder_id} to agent {agent_id}: {e}", file=sys.stderr)
                                    import traceback
                                    traceback.print_exc(file=sys.stderr)
                        else:
                            print(f"WARNING: No folder_ids found for agent {agent_id} - files may not be attached!", file=sys.stderr)
                        
                        # List files attached to the agent
                        try:
                            files_page = await self.client.agents.files.list(agent_id=agent_id, limit=100)
                            attached_files = []
                            async for file in files_page:
                                attached_files.append({
                                    'file_id': file.file_id,
                                    'file_name': file.file_name,
                                    'folder_id': file.folder_id,
                                    'folder_name': file.folder_name,
                                    'is_open': file.is_open
                                })
                            if attached_files:
                                if DEBUG_OUTPUT:
                                    print(f"DEBUG: Agent {agent_id} has {len(attached_files)} files attached:", file=sys.stderr)
                                    for f in attached_files:
                                        print(f"DEBUG:   - {f['file_name']} (folder: {f['folder_name']}, open: {f['is_open']})", file=sys.stderr)
                            else:
                                print(f"WARNING: Agent {agent_id} has NO files attached!", file=sys.stderr)
                        except Exception as e:
                            print(f"WARNING: Failed to list files for agent {agent_id}: {e}", file=sys.stderr)
                        
                        if self.llm_config:
                            model_name = self.llm_config.model
                        elif self.model_handle:
                            model_name = self.model_handle
                        else:
                            model_name = agent.llm_config.model

                        if progress_callback and (self.agent_file or self.agent_script):
                            await progress_callback.agent_loading(sample.id, model_name=model_name)

                        trajectory = []
                        usage_stats: list[dict] = []

                        inputs = sample.input if isinstance(sample.input, list) else [sample.input]
                        total_messages = len(inputs)

                        for i, input_msg in enumerate(inputs):
                            if progress_callback:
                                await progress_callback.message_sending(
                                    sample.id, i + 1, total_messages, agent_id=agent_id, model_name=model_name
                                )

                            # USE MAX_STEPS instead of hardcoded 100
                            stream = await self.client.agents.messages.create(
                                agent_id=agent_id,
                                messages=[MessageCreateParam(role="user", content=str(input_msg))],
                                streaming=True,
                                background=True,
                                stream_tokens=True,
                                include_pings=True,
                                max_steps=MAX_STEPS,  # <-- CHANGED FROM 100
                            )

                            async def _on_chunk(chunk):
                                if not hasattr(chunk, "message_type"):
                                    return

                                if chunk.message_type == "usage_statistics":
                                    usage_rec = None
                                    if hasattr(chunk, "model_dump") and callable(getattr(chunk, "model_dump")):
                                        try:
                                            usage_rec = chunk.model_dump()
                                        except Exception:
                                            usage_rec = None
                                    if usage_rec is None and hasattr(chunk, "dict") and callable(getattr(chunk, "dict")):
                                        try:
                                            usage_rec = chunk.dict()
                                        except Exception:
                                            usage_rec = None
                                    if usage_rec is None and hasattr(chunk, "__dict__"):
                                        try:
                                            usage_rec = dict(chunk.__dict__)
                                        except Exception:
                                            usage_rec = None
                                    if usage_rec is None:
                                        usage_rec = {"raw": str(chunk)}
                                    usage_stats.append(usage_rec)
                                    return

                                if chunk.message_type == "error_message":
                                    detail = getattr(chunk, "detail", None) or getattr(chunk, "message", None) or str(chunk)
                                    raise RuntimeError(f"Error for sample {sample.id}: {detail}")

                            async def _resume_stream(rid: str, seq_id: int):
                                return await self.client.runs.messages.stream(
                                    rid,
                                    starting_after=seq_id,
                                    include_pings=True,
                                )

                            run_id, _ = await consume_stream_with_resumes(
                                stream,
                                resume_stream=_resume_stream,
                                on_chunk=_on_chunk,
                                max_resumes=5,
                                log=logger,
                                description=f"Stream for sample {sample.id}",
                            )

                            if not run_id:
                                raise RuntimeError("Unexpected error: no run ID was found from background stream")

                            messages = await list_all_run_messages(self.client, run_id)
                            trajectory.append(messages)

                        token_data: Optional[list[TurnTokenData]] = None
                        if return_token_data and run_id:
                            token_data = await self._fetch_token_data([run_id])

                        final_agent_state = None
                        if retrieve_agent_state:
                            final_agent_state = await self.client.agents.retrieve(
                                agent_id=agent_id, include=["agent.blocks"]
                            )

                        return TargetResult(
                            trajectory=trajectory,
                            agent_id=agent_id,
                            model_name=model_name,
                            agent_usage=usage_stats,
                            agent_state=final_agent_state,
                            token_data=token_data,
                        )

                except Exception as e:
                    last_error = e
                    attempt += 1

                    if attempt > max_retries:
                        logger.error(
                            f"Failed to run agent for sample {sample.id} after {max_retries} retries. "
                            f"Final error: {type(e).__name__}: {str(e)}"
                        )
                        timeout_hint = f"Timed out after {timeout}s" if isinstance(e, TimeoutError) and timeout else ""
                        msg = str(e) or timeout_hint or type(e).__name__
                        raise TargetError(msg, agent_id=agent_id) from e

                    if agent_id_to_cleanup:
                        try:
                            await self.client.agents.delete(agent_id=agent_id_to_cleanup)
                            logger.info(f"Cleaned up agent {agent_id_to_cleanup} after failed attempt {attempt}")
                        except Exception as cleanup_error:
                            logger.warning(
                                f"Failed to cleanup agent {agent_id_to_cleanup}: {type(cleanup_error).__name__}: {str(cleanup_error)}"
                            )

                    backoff_time = 2 ** (attempt - 1)
                    logger.warning(
                        f"Agent run failed for sample {sample.id} (attempt {attempt}/{max_retries + 1}). "
                        f"Error: {type(e).__name__}: {str(e)}. Retrying in {backoff_time}s..."
                    )
                    await anyio.sleep(backoff_time)

            raise last_error or RuntimeError("Unexpected failure in agent run retry loop")
        
        LettaAgentTarget.run = patched_run
        if DEBUG_OUTPUT:
            print(f"✓ Replaced LettaAgentTarget.run to use max_steps={MAX_STEPS} instead of hardcoded 100", file=sys.stderr)
except Exception as e:
    print(f"ERROR: Error replacing LettaAgentTarget.run: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc(file=sys.stderr)

if __name__ == "__main__":
    app()
