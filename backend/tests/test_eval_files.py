"""Regression sources for long reads, safe CSV and shared formula results."""

import csv
import io

import pytest
from openpyxl import load_workbook

from app import db, file_reading, office_formats, task_results

from .test_eval_execution import request_run


def test_search_finds_answer_deep_in_repetitive_document():
    chunks = [{"source": f"第{i}节", "text": f"第{i}节讨论街区更新中的公共空间与居民参与。"} for i in range(1, 61)]
    chunks[36]["text"] += "首批试点街区是桂香里，预算1260万元，计划2027年6月完工。"
    result = file_reading.search(chunks, "首批试点街区 预算 完工时间")
    assert result["searched_parts"] == 60
    assert result["matches"][0]["part"] == 37
    assert "1260万元" in result["matches"][0]["excerpt"]


def test_sparse_reads_do_not_certify_full_document():
    _, run_id = request_run("这篇长文的预算是多少？")
    coverage = file_reading.record_read(run_id, "fixture", [{"part": 1}, {"part": 60}], 60, [])
    assert coverage["read_ranges"] == [[1, 1], [60, 60]] and not coverage["complete"]
    result = file_reading.verify_claims(run_id, "我已经完整读完了全文。\n预算仍需定位。")
    assert "尚不能确认全文" in result
    assert "预算仍需定位" in result


def test_json_pointer_error_exposes_actual_root_paths():
    result = task_results.path_error({"parts": [{"text": "原文"}], "next_start": 2}, "/result/parts")
    assert "/parts" in result["available_paths"]
    assert task_results.select_path({"a/b": {"~key": "原文"}}, "/a~1b/~0key") == "原文"


def test_csv_formula_with_comma_is_one_field_and_inert():
    raw = office_formats.text_file("csv", rows=[["编号", "备注"], ["M005", '=HYPERLINK("https://example.com","会员")']])
    assert raw.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    assert [len(row) for row in rows] == [2, 2]
    assert rows[1][1].startswith("'=HYPERLINK")
    with pytest.raises(ValueError, match="列数"):
        office_formats.text_file("csv", '编号,备注\nM005,=HYPERLINK("https://example.com","会员")')


def test_csv_inputs_are_exclusive():
    with pytest.raises(ValueError, match="只能提供一项"):
        office_formats.text_file("csv", "a,b", rows=[["a", "b"]])


def test_percentage_formula_and_returned_value_share_same_cache():
    raw, calculations = office_formats.spreadsheet([{"name": "门店", "rows": [
        ["销售额", "目标", "完成率"], [156438.5, 150000, {"formula": "A2/B2", "number_format": "0.0%"}],
        [377400, 400000, {"formula": "A3/B3", "number_format": "0.0%"}],
    ]}], with_values=True)
    workbook = load_workbook(io.BytesIO(raw), data_only=True)
    assert calculations[0]["value"] == workbook["门店"]["C2"].value
    assert calculations[0]["value"] == pytest.approx(1.0429233333333334)
    workbook.close()


def test_legacy_word_explains_conversion():
    with pytest.raises(ValueError, match="另存为.docx"):
        office_formats.parse(b"legacy", "合同.doc")


def test_tenfold_percentage_error_is_rejected_before_publication():
    with pytest.raises(ValueError, match="完成率与销售额/目标不一致"):
        office_formats.spreadsheet([{"name": "经营", "rows": [
            ["销售额", "销售目标", "完成率"], [156438.5, 150000, .104292],
        ]}])
