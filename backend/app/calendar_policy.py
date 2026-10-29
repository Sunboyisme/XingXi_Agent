"""Small calendar policies derived only from user requests and read evidence."""

import re
from datetime import datetime, timedelta


def creation_authorized(text):
    if re.search(r"(?:别|不要|不用|先不|暂不).{0,8}(?:写|创建|保存|安排|加)|先给方案|只讨论|先讨论", text):
        return False
    return bool(re.search(r"安排|提醒|记得|记一下|记下|放进日历|放入日历|写入日历|加到日历|添加.{0,8}(?:计划|日程)|(?:创建|新建|新增|保存|写入)[^。；;\n]{0,40}(?:计划|日程|日历|事项|会议)(?!书|文档|报告|方案|表)|每.{0,8}(?:天|周|月|年).{0,40}(?:一次|交|跑步|学习|整理)|帮我约", text))


def similar_title(first, second):
    a = set(re.sub(r"[\W\d_]", "", first).casefold())
    b = set(re.sub(r"[\W\d_]", "", second).casefold())
    return bool(a and b and len(a & b) / len(a | b) >= .85)


def reminder_offsets(evidence):
    digits = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    if re.search(r"提前\s*(?:\d+|[一两二三四五六七八九十])\s*(?:天|周).{0,5}(?:上午|下午|晚上|早上|\d{1,2}[:：点])", evidence):
        return []  # A clock on another day is not the same-clock minute offset.
    values = []
    for quantity, unit in re.findall(r"提前\s*(\d+|[一两二三四五六七八九十])\s*(分钟|小时|天|周)", evidence):
        amount = int(quantity) if quantity.isdigit() else digits[quantity]
        values.append(-amount * {"分钟": 1, "小时": 60, "天": 1440, "周": 10080}[unit])
    return sorted(set(values))


def conflicts(value, existing):
    if value.all_day:
        return []
    start, end = datetime.fromisoformat(value.start), datetime.fromisoformat(value.end)
    return [item for item in existing if not item.get("all_day") and item.get("status") == "planned"
            and datetime.fromisoformat(item["start"]) < end
            and datetime.fromisoformat(item["end"]) > start
            and not (item["start"] == value.start and similar_title(item["title"], value.title))]


def date_window(value):
    if value.all_day:
        return value.start, value.end
    from zoneinfo import ZoneInfo
    zone = ZoneInfo(value.timezone)
    start = datetime.fromisoformat(value.start).astimezone(zone).date()
    end = datetime.fromisoformat(value.end).astimezone(zone).date() + timedelta(days=1)
    return start.isoformat(), end.isoformat()
