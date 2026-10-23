import httpx
import pytest
from app import tools, utilities, weather

from .test_app import API, wait_run


@pytest.mark.parametrize(
    "expression, expected",
    [
        ("0.1 + 0.2", "0.3"),
        ("(199 + 89) * 0.85", "244.80"),
        ("-5 // 2", "-3"),
        ("-5 % 2", "1"),
        ("2 ** 10", "1024"),
    ],
)
def test_calculator_decimal_arithmetic(expression, expected):
    assert utilities.calculate(expression)["result"] == expected


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os').getcwd()",
        "[1, 2]",
        "True + 1",
        "1 / 0",
        "2 ** 999999",
        "10 ** (10 ** 10)",
        "1e999",
        "1" * 301,
    ],
)
def test_calculator_rejects_code_and_unbounded_work(expression):
    with pytest.raises(ValueError):
        utilities.calculate(expression)


def test_date_offsets_and_timezone_conversion():
    result = utilities.date_time(value="2026-10-15", add_days=30)
    assert result["datetime"] == "2026-11-14T00:00:00+08:00"
    assert result["weekday"] == "星期六"
    result = utilities.date_time(
        "UTC", "2026-10-15T08:00:00+08:00", compare_to="2026-10-17T00:00:00Z"
    )
    assert result["datetime"] == "2026-10-15T00:00:00+00:00"
    assert result["difference_days"] == 2
    # Compare actual elapsed time across daylight-saving changes.
    result = utilities.date_time(
        "America/New_York",
        "2026-03-08T00:00:00-05:00",
        compare_to="2026-03-09T00:00:00-04:00",
    )
    assert result["difference_seconds"] == 23 * 3600


@pytest.mark.parametrize(
    "arguments",
    [
        {"timezone_name": "invalid-zone"},
        {"value": "next Tuesday"},
        {"value": "9999-12-31", "add_days": 10},
        {"timezone_name": "America/New_York", "value": "2026-03-08T02:30:00"},
    ],
)
def test_dates_reject_invalid_or_ambiguous_values(arguments):
    with pytest.raises(ValueError):
        utilities.date_time(**arguments)


@pytest.mark.parametrize(
    "number, source, target, expected",
    [
        ("5", "mile", "km", "8.04672"),
        ("32", "f", "c", "0"),
        ("0", "c", "k", "273.15"),
        ("36", "km/h", "m/s", "1E+1"),
    ],
)
def test_unit_conversion(number, source, target, expected):
    assert utilities.convert_units(number, source, target)["result"] == expected


@pytest.mark.parametrize(
    "number, source, target",
    [
        ("NaN", "kg", "g"),
        ("1", "kg", "km"),
        ("1", "yuan", "usd"),
        ("-1", "k", "c"),
    ],
)
def test_units_reject_invalid_values(number, source, target):
    with pytest.raises(ValueError):
        utilities.convert_units(number, source, target)


@pytest.fixture
def weather_transport(monkeypatch):
    calls = []
    location = {
        "id": 1809858,
        "name": "广州",
        "admin1": "广东",
        "country": "中国",
        "country_code": "CN",
        "latitude": 23.12,
        "longitude": 113.25,
    }
    data = {
        "timezone": "Asia/Shanghai",
        "utc_offset_seconds": 28800,
        "current": {
            "time": "2026-10-15T10:00",
            "temperature_2m": 25,
            "weather_code": 3,
        },
        "daily": {
            "time": ["2026-10-15"],
            "weather_code": [61],
            "temperature_2m_max": [28],
            "temperature_2m_min": [21],
            "precipitation_probability_max": [65],
        },
    }

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={"results": [location]}
            if request.url.path.endswith("search")
            else data,
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        weather,
        "AsyncClient",
        lambda **_: original(transport=httpx.MockTransport(respond)),
    )
    return calls, location


@pytest.mark.asyncio
async def test_weather_returns_location_forecast_units_and_source(weather_transport):
    calls, _ = weather_transport
    result = await weather.get_weather("广州", 3, "CN")
    assert result["location"]["admin1"] == "广东"
    assert result["current"]["temperature_c"] == 25
    assert result["forecast"][0]["condition"] == "小雨"
    assert result["forecast"][0]["precipitation_probability_percent"] == 65
    assert result["source"]["data_url"].startswith(weather.FORECAST_URL)
    assert calls[0].url.params["countryCode"] == "CN"
    assert calls[1].url.params["forecast_days"] == "3"
    assert calls[1].url.params["timezone"] == "auto"


@pytest.mark.asyncio
async def test_ambiguous_weather_requires_confirmation(monkeypatch):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": 1,
                        "name": "同名市",
                        "admin1": "甲省",
                        "latitude": 1,
                        "longitude": 2,
                    },
                    {
                        "id": 2,
                        "name": "同名市",
                        "admin1": "乙省",
                        "latitude": 3,
                        "longitude": 4,
                    },
                ]
            },
        )

    original = httpx.AsyncClient
    monkeypatch.setattr(
        weather,
        "AsyncClient",
        lambda **_: original(transport=httpx.MockTransport(respond)),
    )
    result = await weather.get_weather("同名市")
    assert result["needs_clarification"] and len(calls) == 1
    assert "current" not in result and len(result["locations"]) == 2


def test_catalog_matches_agent_tools_and_search_configuration(client, isolate):
    catalog = client.get(API + "/tools").json()
    assert {item["id"] for item in catalog if item["enabled"] and item["available"]} == {
        tool.name for tool in tools.build_tools("unused", "unused")
    }
    assert next(item for item in catalog if item["id"] == "get_weather")["available"]
    assert not next(item for item in catalog if item["id"] == "web_search")["available"]
    isolate["search"] = "synthetic-key"
    catalog = client.get(API + "/tools").json()
    skill_tools = {"load_skill", "read_skill_file", "run_skill_script"}
    assert all(item["available"] for item in catalog if item["id"] not in skill_tools | {"generate_image"})
    assert all(not item["available"] for item in catalog if item["id"] in skill_tools)


@pytest.mark.parametrize(
    "prompt, expected_names",
    [
        ("帮我计算并换算单位，再查一下日期", {"计算器", "单位换算", "日期与时区"}),
        ("查资料", {"搜索资料"}),
    ],
)
def test_agent_utility_loop_and_persisted_events(configured, prompt, expected_names, isolate, monkeypatch):
    if prompt == "查资料":
        isolate["search"] = "synthetic-key"
        async def unavailable(query):
            raise httpx.ConnectError("isolated service failure")
        monkeypatch.setattr(tools.search, "search_web", unavailable)
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": prompt},
        ),
    )
    assert run["status"] == "completed", run
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    assert {event["data"]["name"] for event in events} == expected_names
    if prompt == "查资料":
        assert events[0]["data"]["status"] == "error"
        assert events[0]["data"]["result"]["error"]
        assert events[0]["data"]["result"]["category"] == "connection_error"
    else:
        results = {event["data"]["name"]: event["data"]["result"] for event in events}
        assert results["计算器"]["result"] == "244.80"
        assert results["单位换算"]["result"] == "8.04672"
        assert results["日期与时区"]["datetime"] == "2026-11-14T00:00:00+08:00"


def test_weather_agent_loop_and_failure_are_audited(configured, monkeypatch):
    async def failed(**kwargs):
        raise httpx.ConnectError("synthetic network failure")

    monkeypatch.setattr(weather, "get_weather", failed)
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "广州天气"},
        ),
    )
    assert run["status"] == "completed", run
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    assert events[0]["data"]["status"] == "error"
    assert "天气查询失败" in events[0]["data"]["result"]["error"]
    assert configured.get(f"{API}/runs/missing/tools").status_code == 404


def test_weather_agent_loop_uses_adapter_and_persists_source(
    configured, weather_transport
):
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "广州天气"},
        ),
    )
    assert run["status"] == "completed", run
    event = configured.get(f"{API}/runs/{run['id']}/tools").json()[0]["data"]
    assert event["status"] == "completed"
    assert event["result"]["current"]["temperature_c"] == 25
    assert event["result"]["source"]["name"] == "Open-Meteo"
