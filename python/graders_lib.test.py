#!/usr/bin/env python3

import grader_lib as graders

# Test conversation
conversation = [
    {"role": "user", "content": "Find me a LinkedIn agent"},
    {"role": "assistant", "content": "What tone do you prefer?"},
    {"role": "user", "content": "Professional"},
    {"role": "assistant", "content": "I recommend the captionist agent for LinkedIn content creation."}
]

ground_truth = {
    "max_turns": 4,
    "expected_listings": ["captionist"],
    "mode": "discovery",
    "expected_questions": 1,
}

print("Testing graders...")
print()

print("1. check_turn_limit:")
print(graders.check_turn_limit(conversation, ground_truth))
print()

print("2. check_expected_items:")
print(graders.check_expected_items(conversation, ground_truth))
print()

print("3. validate_question_count:")
print(graders.validate_question_count(conversation, ground_truth))
print()

print("4. detect_hallucination_patterns:")
print(graders.detect_hallucination_patterns(conversation, ground_truth))
print()

print("✅ All graders tested successfully!")