const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;
    const userId = req.body.user_id;
    const responseUrl = req.body.response_url;

    // 🔐 1. whitelist check
    if (!ALLOWED_USERS.includes(userId)) {
        return res.json({
            response_type: "ephemeral",
            text: "⛔ You are not allowed to use this command."
        });
    }

    // ⏱️ 2. immediate response (fix Slack timeout)
    res.json({
        response_type: "ephemeral",
        text: "⏳ Generating BPMN diagram..."
    });

    // ⚡ 3. async Claude call (CHEAP model)
    try {
        const result = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 1000,
            messages: [
                {
                    role: "user",
                    content: `You are a BPMN expert. Return ONLY PlantUML code.\n\nConvert this workflow:\n${userText}`
                }
            ]
        });

        const plantuml = result.content[0].text;

        const encoded = encodeURIComponent(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/~1${encoded}`;

        // 📩 send result back to Slack
        await axios.post(responseUrl, {
            response_type: "in_channel",
            text: "📊 Your BPMN Diagram:",
            attachments: [
                {
                    image_url: imageUrl,
                    text: plantuml
                }
            ]
        });

    } catch (err) {
        console.error(err);

        await axios.post(responseUrl, {
            text: "❌ Error generating BPMN diagram"
        });
    }
});
