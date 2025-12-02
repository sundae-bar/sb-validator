"""
Custom __init__.py content for letta_evals.graders module
This makes our custom graders discoverable
"""

# Import all custom graders and expose them at module level
from .grader_lib import (
    check_expected_items,
    validate_question_count,
    check_turn_limit,
    detect_hallucination_patterns,
    check_tool_usage,
    check_response_length,
    check_format_compliance,
    check_safety_compliance,
)

__all__ = [
    'check_expected_items',
    'validate_question_count',
    'check_turn_limit',
    'detect_hallucination_patterns',
    'check_tool_usage',
    'check_response_length',
    'check_format_compliance',
    'check_safety_compliance',
]