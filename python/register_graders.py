#!/usr/bin/env python3
"""
Register custom graders with letta-evals registry
This must be imported before letta-evals CLI runs
"""

import sys
import importlib.util

# Import the grader_lib module
spec = importlib.util.spec_from_file_location(
    "grader_lib",
    "/usr/local/lib/python3.11/dist-packages/letta_evals/graders/grader_lib.py"
)
grader_lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader_lib)

# Try to find and populate the registry
try:
    from letta_evals.graders import tool
    
    # Check if there's a registry dict we can populate
    if hasattr(tool, '_GRADER_REGISTRY'):
        registry = tool._GRADER_REGISTRY
    elif hasattr(tool, 'GRADER_REGISTRY'):
        registry = tool.GRADER_REGISTRY
    else:
        # Create a registry if it doesn't exist
        registry = {}
        tool._GRADER_REGISTRY = registry
    
    # Register all grader functions
    registry['check_expected_items'] = grader_lib.check_expected_items
    registry['validate_question_count'] = grader_lib.validate_question_count
    registry['check_turn_limit'] = grader_lib.check_turn_limit
    registry['detect_hallucination_patterns'] = grader_lib.detect_hallucination_patterns
    registry['check_tool_usage'] = grader_lib.check_tool_usage
    registry['check_response_length'] = grader_lib.check_response_length
    registry['check_format_compliance'] = grader_lib.check_format_compliance
    registry['check_safety_compliance'] = grader_lib.check_safety_compliance
    
    print(f"Registered {len(registry)} custom graders")
    
except Exception as e:
    print(f"Warning: Could not register graders via registry: {e}")
    print("Will attempt alternative registration method...")
    
    # Alternative: monkey-patch the loader function
    try:
        from letta_evals.graders import tool
        
        original_load = tool._load_grader_function if hasattr(tool, '_load_grader_function') else None
        
        def patched_load(function_path: str):
            # Try to load from grader_lib first
            if hasattr(grader_lib, function_path):
                return getattr(grader_lib, function_path)
            # Fall back to original loader if it exists
            if original_load:
                return original_load(function_path)
            raise ValueError(f"Grader function '{function_path}' not found")
        
        tool._load_grader_function = patched_load
        print("Applied monkey-patch to grader loader")
        
    except Exception as e2:
        print(f"Error applying monkey-patch: {e2}")
        sys.exit(1)