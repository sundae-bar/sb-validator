#!/usr/bin/env python3
"""
Wrapper script that registers custom graders then runs letta-evals
"""

import sys
import importlib.util

# Register custom graders first
spec = importlib.util.spec_from_file_location(
    "grader_lib",
    "/usr/local/lib/python3.11/dist-packages/letta_evals/graders/grader_lib.py"
)
grader_lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader_lib)

# Import and patch the tool module
from letta_evals.graders import tool

# Try to find the registry
registry = None
if hasattr(tool, '_GRADER_REGISTRY'):
    registry = tool._GRADER_REGISTRY
elif hasattr(tool, 'GRADER_REGISTRY'):
    registry = tool.GRADER_REGISTRY

if registry is not None:
    # Register all grader functions
    registry['check_expected_items'] = grader_lib.check_expected_items
    registry['validate_question_count'] = grader_lib.validate_question_count
    registry['check_turn_limit'] = grader_lib.check_turn_limit
    registry['detect_hallucination_patterns'] = grader_lib.detect_hallucination_patterns
    registry['check_tool_usage'] = grader_lib.check_tool_usage
    registry['check_response_length'] = grader_lib.check_response_length
    registry['check_format_compliance'] = grader_lib.check_format_compliance
    registry['check_safety_compliance'] = grader_lib.check_safety_compliance
    print(f"✓ Registered {len(registry)} custom graders in registry", file=sys.stderr)
else:
    # Monkey-patch the loader function
    original_load = getattr(tool, '_load_grader_function', None)
    
    def patched_load(function_path: str):
        if hasattr(grader_lib, function_path):
            return getattr(grader_lib, function_path)
        if original_load:
            return original_load(function_path)
        raise ValueError(f"Grader function '{function_path}' not found")
    
    tool._load_grader_function = patched_load
    print("✓ Applied monkey-patch to grader loader", file=sys.stderr)

# Fix argv so it looks like: ['letta-evals', 'run', 'suite.yaml', '--output', '...']
# Currently it's: ['/app/python/run_with_graders.py', 'run', 'suite.yaml', '--output', '...']
sys.argv[0] = 'letta-evals'

# Now run letta-evals CLI
from letta_evals.cli import app

if __name__ == "__main__":
    app()