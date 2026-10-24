"""Keep grading rubrics internal, including archived run events and feedback."""
PRIVATE_KEYS = {"criteria", "next_criteria", "active_criteria"}
LEARNING_KINDS = {"course", "lesson", "assessment", "learning_intake", "learning_review", "review_assessment"}


def public(value):
    if isinstance(value, dict):
        return {key: public(item) for key, item in value.items() if key not in PRIVATE_KEYS}
    if isinstance(value, list):
        return [public(item) for item in value]
    return value
