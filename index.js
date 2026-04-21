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

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;
    const userId = req.body.user_id;
    const responseUrl = req.body.response_url;

    // 🔐 1. Whitelist check
    if (!ALLOWED_USERS.includes(userId)) {
        return res.json({
            response_type: "ephemeral",
            text: "⛔ You are not allowed to use this command."
        });
    }

    // ⏱️ 2. Immediate ACK to avoid Slack 3s timeout
    res.json({
        response_type: "ephemeral",
        text: "⏳ Generating BPMN diagram..."
    });

    // ⚡ 3. Async Claude call
    try {
        const result = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1000,
            messages: [
                {
                    role: "user",
                    content: `You are a BPMN expert. Return ONLY valid PlantUML BPMN code, no explanation, no markdown fences.\n\nConvert this workflow to PlantUML:\n${userText}`
                }
            ]
        });

        const plantuml = result.content[0].text.trim();
        const encoded = encodePlantUML(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/${encoded}`;

        // draw.io XML import URL (diagram encoded as XML)
        const drawioXml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="" style="shape=image;image=${imageUrl}" vertex="1" parent="1"><mxGeometry width="800" height="600" as="geometry"/></mxCell></root></mxGraphModel>`;
        const drawioUrl = `https://app.diagrams.net/?splash=0&xml=${encodeURIComponent(drawioXml)}`;

        // 📩 Send result back to Slack
        await axios.post(responseUrl, {
            response_type: "in_channel",
            text: "📊 *Your BPMN Diagram:*",
            attachments: [
                {
                    image_url: imageUrl,
                    text: `\`\`\`\n${plantuml}\n\`\`\``
                },
                {
                    text: `🔗 <${drawioUrl}|Open in draw.io>`
                }
            ]
        });
    } catch (err) {
        console.error(err);
        await axios.post(responseUrl, {
            response_type: "ephemeral",
            text: "❌ Error generating BPMN diagram. Please try again."
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ BPMN bot listening on port ${PORT}`));
