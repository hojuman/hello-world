import os
import json
import pathlib
from typing import Optional

import httpx
import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = pathlib.Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Fantasy Hockey AI")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

claude = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
FANTRAX_URL = "https://www.fantrax.com/fxpa/req"


# ── Models ────────────────────────────────────────────────────────────────────

class LeagueConfig(BaseModel):
    league_id: str
    team_id: str
    session_token: str


class RecommendRequest(BaseModel):
    league_id: str
    team_id: str
    session_token: str
    rec_type: str  # waiver | lineup | trade | general
    trade_details: Optional[str] = None


# ── Fantrax client ────────────────────────────────────────────────────────────

async def fantrax_post(league_id: str, token: str, reqs: list) -> list:
    headers = {
        "Cookie": f"fantrax.st={token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{FANTRAX_URL}?leagueId={league_id}",
            headers=headers,
            json={"requests": reqs},
        )
    if r.status_code in (401, 403):
        raise HTTPException(401, "Invalid Fantrax session token — re-copy from browser cookies.")
    if r.status_code == 404:
        raise HTTPException(404, "League not found. Check your League ID.")
    r.raise_for_status()
    return r.json().get("responses", [])


def truncate_json(data: dict | list, max_chars: int = 7000) -> str:
    text = json.dumps(data, indent=2)
    if len(text) > max_chars:
        return text[:max_chars] + "\n... [truncated for length]"
    return text


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return HTMLResponse((STATIC_DIR / "index.html").read_text())


@app.post("/api/roster")
async def get_roster(cfg: LeagueConfig):
    responses = await fantrax_post(
        cfg.league_id, cfg.session_token,
        [{"x": "getTeamRoster", "token": "", "leagueId": cfg.league_id,
          "teamId": cfg.team_id, "forTrade": False}],
    )
    return responses[0] if responses else {}


@app.post("/api/waiver")
async def get_waiver(cfg: LeagueConfig):
    responses = await fantrax_post(
        cfg.league_id, cfg.session_token,
        [{"x": "getAvailablePlayers", "token": "", "leagueId": cfg.league_id,
          "maxResultsPerRequest": 40, "offset": 0,
          "statusOrScoringPeriodId": "A", "sortedBy": "SCORE", "view": "STATS"}],
    )
    return responses[0] if responses else {}


@app.post("/api/standings")
async def get_standings(cfg: LeagueConfig):
    responses = await fantrax_post(
        cfg.league_id, cfg.session_token,
        [{"x": "getStandings", "token": "", "leagueId": cfg.league_id}],
    )
    return responses[0] if responses else {}


@app.post("/api/teams")
async def get_teams(cfg: LeagueConfig):
    """List all teams in the league so the user can find their team ID."""
    responses = await fantrax_post(
        cfg.league_id, cfg.session_token,
        [{"x": "getTeams", "token": "", "leagueId": cfg.league_id}],
    )
    return responses[0] if responses else {}


@app.post("/api/recommend")
async def recommend(req: RecommendRequest):
    fantrax_reqs = [
        {"x": "getTeamRoster", "token": "", "leagueId": req.league_id,
         "teamId": req.team_id, "forTrade": False},
        {"x": "getStandings", "token": "", "leagueId": req.league_id},
    ]
    labels = ["My Roster", "League Standings"]

    if req.rec_type in ("waiver", "general"):
        fantrax_reqs.append({
            "x": "getAvailablePlayers", "token": "", "leagueId": req.league_id,
            "maxResultsPerRequest": 25, "offset": 0,
            "statusOrScoringPeriodId": "A", "sortedBy": "SCORE", "view": "STATS",
        })
        labels.append("Top Available (Waiver Wire) Players")

    responses = await fantrax_post(req.league_id, req.session_token, fantrax_reqs)

    context = "\n\n".join(
        f"### {labels[i]}\n```json\n{truncate_json(r)}\n```"
        for i, r in enumerate(responses)
    )

    prompts = {
        "waiver": (
            "Based on my roster and the available waiver wire players, recommend the top 5 pickups. "
            "For each one: name the player, explain why they're worth adding, and name the specific "
            "roster player I should drop to make room. Reference actual stats."
        ),
        "lineup": (
            "Analyze my roster and recommend the optimal starting lineup for this week. "
            "Who should I start? Who should I bench? Reference recent form, matchups, and stats."
        ),
        "trade": (
            f"Trade proposal — {req.trade_details or 'see details below'}.\n\n"
            "Analyze both sides fairly. Should I accept or reject? Give a clear verdict and reasoning "
            "with specific stat comparisons."
        ),
        "general": (
            "Give me a full fantasy hockey team analysis:\n\n"
            "## 1. Strengths\nWhat is working well on my roster?\n\n"
            "## 2. Weaknesses\nWhere am I vulnerable in the standings?\n\n"
            "## 3. Top 5 Actions\nSpecific moves I should make this week (waiver adds, drops, lineup changes).\n\n"
            "## 4. Season Outlook\nBased on my position in the standings, what's my realistic path?"
        ),
    }

    user_prompt = prompts.get(req.rec_type, prompts["general"])

    async def event_stream():
        try:
            async with claude.messages.stream(
                model="claude-opus-4-7",
                max_tokens=2048,
                thinking={"type": "adaptive"},
                system=(
                    "You are an elite fantasy hockey analyst. You have expert knowledge of NHL players, "
                    "line combinations, injuries, power-play units, and Fantrax scoring systems. "
                    "You give specific, actionable recommendations referencing actual player names and stats. "
                    "Format your responses clearly with markdown headers and bullet points."
                ),
                messages=[{
                    "role": "user",
                    "content": f"My Fantrax league data:\n\n{context}\n\n---\n\n{user_prompt}",
                }],
            ) as stream:
                async for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text})}\n\n"
            yield "data: [DONE]\n\n"
        except HTTPException as e:
            yield f"data: {json.dumps({'error': e.detail})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
