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

// Build a draw.io URL with the PlantUML source embedded as a native PlantUML cell
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

// ─── STEP 1 PROMPT: Extract workflow from messy input ────────────────────────
// Accepts anything: Slack conversations, bullet points, paragraphs, mixed text.
// Returns ONLY a clean, structured workflow — no chit-chat, no unrelated content.
const EXTRACT_PROMPT = `You are a business analyst. Your job is to read the input below — which may be a Slack conversation, meeting notes, bullet points, or a mix of relevant and irrelevant content — and extract ONLY the workflow or process steps described.

OUTPUT FORMAT (strict):
- Return a titled, numbered list of workflow steps
- Each step must be a clear action (verb + object), e.g. "User submits invoice"
- Include decision points as: DECISION: <condition> → YES: <action> / NO: <action>
- Ignore: greetings, reactions, off-topic chat, timestamps, usernames, emoji-only messages, jokes, side discussions
- If no clear workflow is found, reply with exactly: NO_WORKFLOW_FOUND
- Do NOT include any explanation, preamble, or markdown — output ONLY the structured workflow list

Input:
`;

// ─── STEP 2 PROMPT: Convert clean workflow to PlantUML ───────────────────────
const PLANTUML_PROMPT = `You are a PlantUML expert. Convert the structured workflow below into a PlantUML UML Activity Diagram (beta syntax) — a single vertical flow with decision diamonds and merge points, like a classic flowchart.

STRICT RULES:
- Start with @startuml and end with @enduml
- Add a title using: title <Workflow Title>
- Add these skinparam lines:
    skinparam backgroundColor #FEFEFE
    skinparam activityBackgroundColor #FFFFFF
    skinparam activityBorderColor #555555
    skinparam activityDiamondBackgroundColor #FFFFFF
    skinparam activityDiamondBorderColor #555555
    skinparam arrowColor #333333
    skinparam roundcorner 10
- Use start for the initial filled circle
- Use stop for the final filled circle
- Use :Action label; for every process step (ends with semicolon)
- Use if (condition?) then (Yes) ... else (No) ... endif for decisions
- Keep the entire flow in ONE single column — NO swimlanes, NO | Actor | syntax
- Do NOT use sequence diagram syntax
- Do NOT wrap output in markdown fences or backticks
- Output ONLY raw PlantUML code

Workflow:
`;

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;
    const userId = req.body.user_id;
    const responseUrl = req.body.response_url;

    // 1. Whitelist check
    if (!ALLOWED_USERS.includes(userId)) {
        return res.json({
            response_type: "ephemeral",
            text: "⛔ You are not allowed to use this command."
        });
    }

    // 2. Immediate ACK to avoid Slack 3s timeout
    res.json({
        response_type: "ephemeral",
        text: "⏳ Analysing input and generating diagram..."
    });

    try {
        // ── STEP 1: Extract the workflow from raw input ──────────────────────
        const extractResult = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1000,
            messages: [{ role: "user", content: EXTRACT_PROMPT + userText }]
        });

        const extractedWorkflow = extractResult.content[0].text.trim();

        // If no workflow found, tell the user clearly
        if (extractedWorkflow === "NO_WORKFLOW_FOUND") {
            await axios.post(responseUrl, {
                response_type: "ephemeral",
                text: "⚠️ I couldn't find a workflow in your input. Please describe the process steps you want to diagram, e.g.:\n> `/bpmn User submits invoice → Finance reviews → Approved? Yes: pay / No: reject`"
            });
            return;
        }

        // ── STEP 2: Generate PlantUML from clean workflow ────────────────────
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

        // ── Build URLs ───────────────────────────────────────────────────────
        const encoded = encodePlantUML(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/${encoded}`;
        const drawioUrl = buildDrawioUrl(plantuml);

        // ── Send result to Slack ─────────────────────────────────────────────
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
                {
                    type: "divider"
                },
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
