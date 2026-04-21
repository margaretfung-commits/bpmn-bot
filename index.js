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

// Build a draw.io URL that pre-loads the diagram.
//
// How draw.io PlantUML embedding works:
//   draw.io has a native cell style "plantuml=1" — when a cell has this style,
//   draw.io renders the cell's VALUE as PlantUML code using its built-in renderer.
//   We encode the full mxGraphModel XML into the ?xml= query param.
//   draw.io reads it on load and renders the diagram immediately — no plugin needed.
function buildDrawioUrl(plantuml) {
    // XML-escape the PlantUML so it is safe inside an XML attribute value
    const safe = plantuml
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // The cell value IS the PlantUML source. The style "plantuml=1" tells
    // draw.io to render it as a PlantUML diagram shape.
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

const PLANTUML_PROMPT = `You are a PlantUML expert. Convert the workflow below into a PlantUML UML Activity Diagram (beta syntax) — a single vertical flow with decision diamonds and merge points, like a classic flowchart.

STRICT RULES:
- Start with @startuml and end with @enduml
- Add a title using: title <Workflow Title>
- Add these skinparam lines after @startuml:
    skinparam backgroundColor #FEFEFE
    skinparam activityBackgroundColor #FFFFFF
    skinparam activityBorderColor #555555
    skinparam activityDiamondBackgroundColor #FFFFFF
    skinparam activityDiamondBorderColor #555555
    skinparam arrowColor #333333
    skinparam roundcorner 10
- Use start for the initial filled circle
- Use stop for the final filled circle (end node)
- Use :Action label; for every process step (rounded rectangle, ends with semicolon)
- Use if (condition?) then (Yes) for decision diamonds, with else (No) and endif
- After branching paths rejoin, PlantUML auto-merges after endif — just continue the flow
- Keep the entire flow in ONE single column — NO swimlanes, NO | Actor | syntax
- Do NOT use sequence diagram syntax (no participant, activate, ->)
- Do NOT use swimlanes or | pipes |
- Do NOT wrap output in markdown fences, backticks, or any explanation
- Output ONLY raw PlantUML code

Workflow to convert:
`;

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;
    const userId = req.body.user_id;
    const responseUrl = req.body.response_url;

    // 1. Whitelist check
    if (!ALLOWED_USERS.includes(userId)) {
        return res.json({
            response_type: "ephemeral",
            text: "You are not allowed to use this command."
        });
    }

    // 2. Immediate ACK to avoid Slack 3s timeout
    res.json({
        response_type: "ephemeral",
        text: "Generating activity diagram..."
    });

    // 3. Async Claude call
    try {
        const result = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2000,
            messages: [{ role: "user", content: PLANTUML_PROMPT + userText }]
        });

        // Strip any markdown fences Claude may have added despite instructions
        const plantuml = result.content[0].text
            .trim()
            .replace(/^```[a-z]*\n?/i, "")
            .replace(/```\s*$/i, "")
            .trim();

        // 1. PlantUML PNG — shown as preview image inside Slack
        const encoded = encodePlantUML(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/${encoded}`;

        // 2. draw.io URL — opens draw.io with the diagram pre-loaded as a PlantUML shape
        const drawioUrl = buildDrawioUrl(plantuml);

        // Send result back to Slack
        await axios.post(responseUrl, {
            response_type: "in_channel",
            blocks: [
                {
                    type: "section",
                    text: { type: "mrkdwn", text: "*Your Activity Diagram:*" }
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
                        text: `*Edit in draw\.io:*\n${drawioUrl}`
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*PlantUML source:*\n\`\`\`${plantuml}\`\`\``
                    }
                }
            ]
        });
    } catch (err) {
        console.error(err);
        await axios.post(responseUrl, {
            response_type: "ephemeral",
            text: "Error generating diagram. Please try again."
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BPMN bot listening on port ${PORT}`));
