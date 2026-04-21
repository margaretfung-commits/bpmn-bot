const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const pako = require("pako");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ALLOWED_USERS = ["U04ERCL1490"];
const app = express();
app.use(express.urlencoded({ extended: true }));

// PlantUML uses its own deflate+base64 encoding (NOT standard encodeURIComponent)
function encodePlantUML(text) {
    const data = new TextEncoder().encode(text);
    const compressed = pako.deflateRaw(data, { level: 9 });
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
    let result = "";
    for (let i = 0; i < compressed.length; i += 3) {
        const b1 = compressed[i];
        const b2 = compressed[i + 1] ?? 0;
        const b3 = compressed[i + 2] ?? 0;
        result += chars[(b1 >> 2) & 0x3F];
        result += chars[((b1 & 0x3) << 4) | ((b2 >> 4) & 0xF)];
        result += chars[((b2 & 0xF) << 2) | ((b3 >> 6) & 0x3)];
        result += chars[b3 & 0x3F];
    }
    return result;
}

function buildDrawioUrl(plantuml) {
    const safe = plantuml
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const xml =
        `<mxGraphModel><root>` +
        `<mxCell id="0"/>` +
        `<mxCell id="1" parent="0"/>` +
        `<mxCell id="2" value="${safe}" ` +
        `style="shape=mxgraph.plantuml.activity;plantuml=1;whiteSpace=wrap;html=1;" ` +
        `vertex="1" parent="1">` +
        `<mxGeometry x="20" y="20" width="800" height="1100" as="geometry"/>` +
        `</mxCell>` +
        `</root></mxGraphModel>`;
    return `https://app.diagrams.net/?splash=0&xml=${encodeURIComponent(xml)}`;
}

// ── STEP 1: Extract the clean workflow from any raw input ─────────────────────
const EXTRACT_PROMPT = `You are a business analyst. Read the input below — it may be a Slack conversation, meeting notes, bullet points, or mixed content — and extract ONLY the workflow or process steps.

OUTPUT RULES:
- Return a titled, numbered list of workflow steps
- Each step must be a clear action: verb + object, e.g. "User submits invoice"
- Mark decision points as: DECISION: <condition> → YES: <action> / NO: <action>
- Mark which actor/system performs each step, e.g. "[SAP] Send master data files"
- Ignore: greetings, reactions, off-topic chat, timestamps, usernames, emoji-only messages, jokes
- If NO workflow is found, reply with exactly: NO_WORKFLOW_FOUND
- Output ONLY the structured list — no explanation, no preamble, no markdown

Input:
`;

// ── STEP 2: Generate PlantUML — smart style selection ────────────────────────
const PLANTUML_PROMPT = `You are a PlantUML expert. Convert the structured workflow below into a PlantUML Activity Diagram (beta syntax).

FIRST, decide which diagram style to use:

USE SWIMLANES when:
- Two or more distinct actors, systems, or departments are named (e.g. SAP, PO, SIMS, User, Finance)
- Steps clearly pass between different parties (handoffs exist)
- Actors are marked with [ActorName] in the workflow

USE SINGLE-FLOW (no swimlanes) when:
- Only one actor or system performs all steps
- The workflow is a pure decision/validation logic with no handoffs
- No distinct parties are named

═══ SWIMLANE SYNTAX (use when multiple actors) ═══
@startuml
skinparam swimlaneWidth same
skinparam backgroundColor #FEFEFE
skinparam activityBackgroundColor #FFFFFF
skinparam activityBorderColor #555555
skinparam activityDiamondBackgroundColor #FFFFFF
skinparam activityDiamondBorderColor #555555
skinparam arrowColor #333333
title <Workflow Title>
|ActorOne|
start
:First action;
|ActorTwo|
:Receives and processes;
if (Condition?) then (Yes)
  :Handle yes case;
else (No)
  |ActorOne|
  :Handle no case;
endif
|ActorTwo|
:Final step;
stop
@enduml

═══ SINGLE-FLOW SYNTAX (use when one actor) ═══
@startuml
skinparam backgroundColor #FEFEFE
skinparam activityBackgroundColor #FFFFFF
skinparam activityBorderColor #555555
skinparam activityDiamondBackgroundColor #FFFFFF
skinparam activityDiamondBorderColor #555555
skinparam arrowColor #333333
skinparam roundcorner 10
title <Workflow Title>
start
:First step;
if (Condition?) then (Yes)
  :Handle yes;
else (No)
  :Handle no;
  stop
endif
:Continue flow;
stop
@enduml

═══ SUPPORTED SYNTAX (use where appropriate) ═══
- :Action label;          → rounded rectangle step (must end with semicolon)
- if (x?) then (Yes)      → decision diamond
  else (No) / endif       → branch and merge
- fork / fork again       → parallel branches
  end fork                → join parallel branches
- repeat / repeat while   → loop construct
- note right: text        → annotation beside a step
- stop (mid-flow)         → early termination in a branch (e.g. error path)

STRICT OUTPUT RULES:
- Do NOT wrap output in markdown fences or backticks
- Do NOT include any explanation
- Output ONLY the raw PlantUML code starting with @startuml

Workflow:
`;

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;
    const userId = req.body.user_id;
    const responseUrl = req.body.response_url;

    if (!ALLOWED_USERS.includes(userId)) {
        return res.json({
            response_type: "ephemeral",
            text: "⛔ You are not allowed to use this command."
        });
    }

    res.json({
        response_type: "ephemeral",
        text: "⏳ Analysing input and generating diagram..."
    });

    try {
        // ── STEP 1: Extract workflow ──────────────────────────────────────────
        const extractResult = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1000,
            messages: [{ role: "user", content: EXTRACT_PROMPT + userText }]
        });

        const extractedWorkflow = extractResult.content[0].text.trim();

        if (extractedWorkflow === "NO_WORKFLOW_FOUND") {
            await axios.post(responseUrl, {
                response_type: "ephemeral",
                text: "⚠️ I couldn't find a workflow in your input. Try:\n> `/bpmn User submits invoice → Finance reviews → Approved? Yes: pay / No: reject`"
            });
            return;
        }

        // ── STEP 2: Generate PlantUML (auto-selects swimlane vs single-flow) ──
        const plantUmlResult = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2000,
            messages: [{ role: "user", content: PLANTUML_PROMPT + extractedWorkflow }]
        });

        const plantuml = plantUmlResult.content[0].text
            .trim()
            .replace(/^```[a-z]*\n?/i, "")
            .replace(/```\s*$/i, "")
            .trim();

        const encoded = encodePlantUML(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/${encoded}`;
        const drawioUrl = buildDrawioUrl(plantuml);

        await axios.post(responseUrl, {
            response_type: "in_channel",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*📋 Extracted workflow:*\n```" + extractedWorkflow + "```"
                    }
                },
                { type: "divider" },
                {
                    type: "section",
                    text: { type: "mrkdwn", text: "*📊 Activity Diagram:*" }
                },
                {
                    type: "image",
                    image_url: imageUrl,
                    alt_text: "Activity diagram"
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*✏️ Edit in draw\.io:*\n${drawioUrl}`
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*🌿 PlantUML source:*\n\`\`\`${plantuml}\`\`\``
                    }
                }
            ]
        });

    } catch (err) {
        console.error(err);
        await axios.post(responseUrl, {
            response_type: "ephemeral",
            text: "❌ Error generating diagram. Please try again."
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ BPMN bot listening on port ${PORT}`));
