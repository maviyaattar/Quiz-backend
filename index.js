// index.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

/* =======================
   MIDDLEWARE
======================= */
app.use(cors());
app.use(express.json());

/* =======================
   DB CONNECTION
======================= */
const MONGO_URI = process.env.MONGO_URI;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

/* =======================
   SCHEMAS
======================= */
const QuizSchema = new mongoose.Schema({
  code: String,
  title: String,
  description: String,
  duration: { type: Number, default: 1200 }, // 20 minutes
  creatorName: String,
  status: { type: String, default: "created" },
  startTime: Date,
  endTime: Date,
  createdAt: { type: Date, default: Date.now }
});

const SubmissionSchema = new mongoose.Schema({
  quizCode: String,
  name: String,
  branch: String,
  rollNo: String,
  answers: [Number],
  score: Number,
  submittedAt: Date
});

const Quiz = mongoose.model("Quiz", QuizSchema);
const Submission = mongoose.model("Submission", SubmissionSchema);

/* =======================
   HELPERS
======================= */
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* =======================
   API ROUTES
======================= */

/* CREATE QUIZ */
app.post("/api/quiz/create", async (req, res) => {
  try {
    const { title, description, creatorName } = req.body;

    const quiz = await Quiz.create({
      code: generateCode(),
      title,
      description,
      creatorName
    });

    res.json(quiz);
  } catch (err) {
    res.status(500).json({ msg: "Error creating quiz" });
  }
});

/* START QUIZ */
app.post("/api/quiz/start/:code", async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });
    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });

    quiz.status = "live";
    quiz.startTime = new Date();
    quiz.endTime = new Date(Date.now() + quiz.duration * 1000);
    await quiz.save();

    res.json({ msg: "Quiz started", quiz });
  } catch (err) {
    res.status(500).json({ msg: "Error starting quiz" });
  }
});

/* DELETE QUIZ */
app.delete("/api/quiz/delete/:code", async (req, res) => {
  try {
    await Quiz.deleteOne({ code: req.params.code });
    await Submission.deleteMany({ quizCode: req.params.code });

    res.json({ msg: "Quiz deleted" });
  } catch (err) {
    res.status(500).json({ msg: "Error deleting quiz" });
  }
});

/* JOIN QUIZ */
app.post("/api/quiz/join/:code", async (req, res) => {
  try {
    const { rollNo } = req.body;
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz || quiz.status !== "live")
      return res.status(400).json({ msg: "Quiz not available" });

    if (Date.now() > quiz.endTime)
      return res.status(400).json({ msg: "Quiz ended" });

    const already = await Submission.findOne({
      quizCode: quiz.code,
      rollNo
    });

    if (already)
      return res.status(400).json({ msg: "Already attempted" });

    res.json({ msg: "Allowed to join" });
  } catch (err) {
    res.status(500).json({ msg: "Error joining quiz" });
  }
});

/* SUBMIT QUIZ */
app.post("/api/quiz/submit/:code", async (req, res) => {
  try {
    const { name, branch, rollNo, answers } = req.body;
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (Date.now() > quiz.endTime)
      return res.status(400).json({ msg: "Time over" });

    const score = answers.filter(a => a === 1).length;

    await Submission.create({
      quizCode: quiz.code,
      name,
      branch,
      rollNo,
      answers,
      score,
      submittedAt: new Date()
    });

    res.json({ msg: "Submitted successfully", score });
  } catch (err) {
    res.status(500).json({ msg: "Error submitting quiz" });
  }
});

/* SUMMARY */
app.get("/api/quiz/summary/:code", async (req, res) => {
  try {
    const subs = await Submission.find({ quizCode: req.params.code });

    const total = subs.length;
    const highest = Math.max(...subs.map(s => s.score), 0);
    const avg =
      total === 0
        ? 0
        : subs.reduce((sum, s) => sum + s.score, 0) / total;

    res.json({
      totalParticipants: total,
      highestScore: highest,
      averageScore: avg
    });
  } catch (err) {
    res.status(500).json({ msg: "Error fetching summary" });
  }
});

/* LEADERBOARD */
app.get("/api/quiz/leaderboard/:code", async (req, res) => {
  try {
    const leaderboard = await Submission.find({
      quizCode: req.params.code
    })
      .sort({ score: -1, submittedAt: 1 })
      .select("name rollNo score");

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ msg: "Error fetching leaderboard" });
  }
});

/* =======================
   SERVER
======================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
