import datetime as dt
import pytest

from app import create_app

@pytest.fixture()
def client(tmp_path):
    app = create_app({
        "TESTING": True,
        "DATABASE": str(tmp_path / "test.db"),
        "ACCESS_PIN": "2468",
        "SECRET_KEY": "test-secret",
    })
    return app.test_client()


def login(client):
    return client.post("/api/login", json={"pin": "2468"})


def test_wrong_pin_is_rejected(client):
    response = client.post("/api/login", json={"pin": "0000"})
    assert response.status_code == 401


def test_login_allows_access_to_today(client):
    assert login(client).status_code == 200
    response = client.get("/api/today")
    assert response.status_code == 200
    assert response.get_json()["date"] == dt.date.today().isoformat()


def test_first_day_can_only_be_created_for_today(client):
    login(client)
    today = dt.date.today().isoformat()
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    ok = client.post("/api/days", json={"date": today, "statement": "Это мой первый день как я бросил пить"})
    denied = client.post("/api/days", json={"date": yesterday, "statement": "задним числом"})
    assert ok.status_code == 201
    assert denied.status_code == 400


def test_multiple_thoughts_are_archived_with_timestamps(client):
    login(client)
    today = dt.date.today().isoformat()
    client.post("/api/days", json={"date": today, "statement": "Это мой первый день как я бросил пить"})
    first = client.post("/api/thoughts", json={"date": today, "text": "Сегодня выбрал новую жизнь"})
    second = client.post("/api/thoughts", json={"date": today, "text": "Вечером стало спокойнее"})
    assert first.status_code == second.status_code == 201
    day = client.get(f"/api/days/{today}").get_json()
    assert [item["text"] for item in day["thoughts"]] == ["Сегодня выбрал новую жизнь", "Вечером стало спокойнее"]
    assert all(item["created_at"] for item in day["thoughts"])


def test_archive_reports_streak_and_counts(client):
    login(client)
    today = dt.date.today().isoformat()
    client.post("/api/days", json={"date": today, "statement": "Первый день"})
    client.post("/api/thoughts", json={"date": today, "text": "Мысль"})
    archive = client.get("/api/archive").get_json()
    assert archive["stats"]["days"] == 1
    assert archive["stats"]["thoughts"] == 1
    assert archive["stats"]["streak"] == 1
    assert archive["days"][0]["date"] == today


def test_empty_thought_is_rejected(client):
    login(client)
    today = dt.date.today().isoformat()
    response = client.post("/api/thoughts", json={"date": today, "text": "   "})
    assert response.status_code == 400
