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

Example of correct structure:
@startuml
skinparam backgroundColor #FEFEFE
skinparam activityBackgroundColor #FFFFFF
skinparam activityBorderColor #555555
skinparam activityDiamondBackgroundColor #FFFFFF
skinparam activityDiamondBorderColor #555555
skinparam arrowColor #333333
skinparam roundcorner 10
title My Workflow
start
:First step;
if (Condition?) then (Yes)
  :Handle Yes case;
else (No)
  :Handle No case;
  stop
endif
:Merged step continues;
:Final step;
stop
@enduml

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
            messages: [
                {
                    role: "user",
                    content: PLANTUML_PROMPT + userText
                }
            ]
        });

        // Strip any markdown fences Claude may have added despite instructions
        const plantuml = result.content[0].text
            .trim()
            .replace(/^```[a-z]*\n?/i, "")
            .replace(/```\s*$/i, "")
            .trim();

        const encoded = encodePlantUML(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/${encoded}`;

        // draw.io: open with PlantUML XML plugin pre-loaded
        const drawioUrl = `https://app.diagrams.net/?splash=0&p=plantuml&src=${encodeURIComponent(imageUrl)}`;

        // Send result back to Slack
        await axios.post(responseUrl, {
            response_type: "in_channel",
            text: "Your Activity Diagram:",
            attachments: [
                {
                    image_url: imageUrl,
                    text: "```\n" + plantuml + "\n```"
                },
                {
                    text: `Open in draw.io: ${drawioUrl}`
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
