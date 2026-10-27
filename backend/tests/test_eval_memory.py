"""Memory evaluation regression sources; execution belongs to user acceptance."""

from app import config, db, memory, retrieval

from .test_memory import turn


def test_habit_and_multi_intent_extraction_keep_units_and_negation():
    values = memory.extract_statements("我喝咖啡一般只喝燕麦拿铁，少冰。给我推荐秋天的咖啡。")
    assert len(values) == 1 and "少冰" in values[0]["content"]
    assert values[0]["category"] == "preference"
    values = memory.extract_statements("帮我记一下：明天下午两点通电话；以后进货单都按日期-供应商-金额命名；我对芒果过敏。")
    assert len(values) == 2
    assert values[-1]["risk"] == "sensitive"
    assert memory.extract_statements("不要记住我对芒果过敏") == []


def test_unrequested_health_information_stays_pending():
    statement = memory.extract_statements("我有轻度高血压，最近在吃降压药。给我睡前放松建议。")[0]
    run_id, conversation_id, _ = turn("我有轻度高血压，最近在吃降压药。给我睡前放松建议。")
    result = memory.save_from_chat(run_id, conversation_id, **statement)
    assert result["state"] == "candidate"


def test_definite_residence_correction_updates_and_undo_restores_source():
    run_id, conversation_id, _ = turn("请记住：我住在上海徐汇区。")
    original = memory.save_from_chat(run_id, conversation_id, content="用户住在上海徐汇区。",
        evidence="我住在上海徐汇区。", explicit_request=True)
    run_id, conversation_id, _ = turn("我搬家了，现在住在苏州工业园区。")
    result = memory.save_from_chat(run_id, conversation_id, content="用户现在住在苏州工业园区。",
        evidence="我搬家了，现在住在苏州工业园区。", replaces_id=original["id"])
    assert result["id"] == original["id"] and result["state"] == "confirmed"
    memory.undo(result["change_id"])
    with db.Session() as session:
        assert session.get(db.Memory, original["id"]).content == "用户住在上海徐汇区。"


def test_confirmation_mode_never_auto_replaces_residence():
    run_id, conversation_id, _ = turn("请记住：我住在上海徐汇区。")
    original = memory.save_from_chat(run_id, conversation_id, content="用户住在上海徐汇区。",
        evidence="我住在上海徐汇区。", explicit_request=True)
    with db.Session() as session:
        session.get(db.Settings, config.PROFILE_ID).memory_mode = "confirm"
        session.commit()
    run_id, conversation_id, _ = turn("我搬家了，现在住在苏州工业园区。")
    result = memory.save_from_chat(run_id, conversation_id, content="用户现在住在苏州工业园区。",
        evidence="我搬家了，现在住在苏州工业园区。", replaces_id=original["id"])
    assert result["state"] == "candidate" and result["id"] != original["id"]


def test_keyword_fallback_connects_outings_to_residence():
    assert retrieval.keyword_score("周末去哪玩", "用户住在苏州工业园区") > 0
    assert retrieval.keyword_score("周末去哪玩", "用户喜欢短篇回答") < retrieval.keyword_score("周末去哪玩", "用户住在苏州工业园区")
