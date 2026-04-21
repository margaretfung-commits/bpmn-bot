const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));

app.post("/slack/bpmn", async (req, res) => {
    const userText = req.body.text;

    try {
        const aiResponse = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are a BPMN expert. Return ONLY PlantUML code."
                    },
                    {
                        role: "user",
                        content: `Convert this workflow into BPMN PlantUML:\n${userText}`
                    }
                ]
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        const plantuml = aiResponse.data.choices[0].message.content;
        const encoded = encodeURIComponent(plantuml);
        const imageUrl = `https://www.plantuml.com/plantuml/png/~1${encoded}`;

        res.json({
            response_type: "in_channel",
            text: "📊 Your BPMN Diagram:",
            attachments: [
                { image_url: imageUrl },
                { text: "PlantUML:\n" + plantuml }
            ]
        });

    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on " + PORT));
