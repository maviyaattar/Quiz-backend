const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

/* ======================
   CONFIG (RAILWAY)
====================== */
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;

/* ======================
   MIDDLEWARE
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   DB CONNECT
====================== */
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

/* ======================
   SCHEMAS
====================== */
const CreatorSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String
});

const QuizSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  title: String,
  description: String,
  duration: Number, // seconds
  creatorId: mongoose.Schema.Types.ObjectId,
  status: { type: String, default: "created" }, // created | live | ended
  startTime: Date,
  endTime: Date,
  questions: [
    {
      text: String,
      options: [String],
      correctIndex: Number
    }
  ],
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

const Creator = mongoose.model("Creator", CreatorSchema);
const Quiz = mongoose.model("Quiz", QuizSchema);
const Submission = mongoose.model("Submission", SubmissionSchema);

/* ======================
   HELPERS
====================== */
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ msg: "No token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ msg: "Invalid token" });
  }
}

/* ======================
   AUTH ROUTES
====================== */
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (await Creator.findOne({ email }))
    return res.status(400).json({ msg: "Email already exists" });

  const hashed = await bcrypt.hash(password, 10);
  await Creator.create({ name, email, password: hashed });

  res.json({ msg: "Registered successfully" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const creator = await Creator.findOne({ email });
  if (!creator) return res.status(400).json({ msg: "Invalid credentials" });

  const ok = await bcrypt.compare(password, creator.password);
  if (!ok) return res.status(400).json({ msg: "Invalid credentials" });

  const token = jwt.sign({ id: creator._id }, JWT_SECRET, { expiresIn: "1d" });
  res.json({ token, name: creator.name });
});

/* ======================
   CREATOR QUIZ ROUTES
====================== */

/* Create quiz */
app.post("/api/quiz/create", auth, async (req, res) => {
  const { title, description, duration, questions } = req.body;

  if (!title || !questions?.length)
    return res.status(400).json({ msg: "Invalid data" });

  const quiz = await Quiz.create({
    code: generateCode(),
    title,
    description,
    duration,
    creatorId: req.user.id,
    questions
  });

  res.json(quiz);
});

/* Get my quizzes (DASHBOARD) */
app.get("/api/quiz/my", auth, async (req, res) => {
  const quizzes = await Quiz.find({ creatorId: req.user.id })
    .select("code title description status createdAt");

  res.json(quizzes);
});

/* Get single quiz (TEST PAGE) */
app.get("/api/quiz/:code", auth, async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (quiz.creatorId.toString() !== req.user.id)
    return res.status(403).json({ msg: "Access denied" });

  res.json(quiz);
});

/* Start quiz */
app.post("/api/quiz/start/:code", auth, async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (quiz.creatorId.toString() !== req.user.id)
    return res.status(403).json({ msg: "Not your quiz" });

  if (quiz.status === "live")
    return res.status(400).json({ msg: "Quiz already live" });

  quiz.status = "live";
  quiz.startTime = new Date();
  quiz.endTime = new Date(Date.now() + quiz.duration * 1000);

  await quiz.save();
  res.json({ msg: "Quiz started" });
});

/* Delete quiz */
app.delete("/api/quiz/delete/:code", auth, async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (quiz.creatorId.toString() !== req.user.id)
    return res.status(403).json({ msg: "Not your quiz" });

  await Quiz.deleteOne({ code: quiz.code });
  await Submission.deleteMany({ quizCode: quiz.code });

  res.json({ msg: "Quiz deleted" });
});

/* ======================
   PARTICIPANT ROUTES
====================== */

/* Join quiz */
app.post("/api/quiz/join/:code", async (req, res) => {
  const { rollNo } = req.body;
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });

  if (quiz.status !== "live")
    return res.json({ status: quiz.status });

  if (Date.now() > quiz.endTime)
    return res.status(400).json({ msg: "Quiz ended" });

  if (await Submission.findOne({ quizCode: quiz.code, rollNo }))
    return res.status(400).json({ msg: "Already attempted" });

  res.json({ status: "allowed", endTime: quiz.endTime });
});

/* Get questions (NO ANSWERS) */
app.get("/api/quiz/questions/:code", async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz || quiz.status !== "live")
    return res.status(400).json({ msg: "Quiz not live" });

  res.json({
    endTime: quiz.endTime,
    questions: quiz.questions.map(q => ({
      text: q.text,
      options: q.options
    }))
  });
});

/* Submit quiz */
app.post("/api/quiz/submit/:code", async (req, res) => {
  const { name, branch, rollNo, answers } = req.body;
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (Date.now() > quiz.endTime)
    return res.status(400).json({ msg: "Time over" });

  if (await Submission.findOne({ quizCode: quiz.code, rollNo }))
    return res.status(400).json({ msg: "Already submitted" });

  let score = 0;
  quiz.questions.forEach((q, i) => {
    if (answers[i] === q.correctIndex) score++;
  });

  await Submission.create({
    quizCode: quiz.code,
    name,
    branch,
    rollNo,
    answers,
    score,
    submittedAt: new Date()
  });

  res.json({ score, total: quiz.questions.length });
});

/* ======================
   RESULTS
====================== */

/* Leaderboard */
app.get("/api/quiz/leaderboard/:code", async (req, res) => {
  const data = await Submission.find({ quizCode: req.params.code })
    .sort({ score: -1, submittedAt: 1 })
    .select("name rollNo score");

  res.json(data);
});

/* Summary */
app.get("/api/quiz/summary/:code", async (req, res) => {
  const subs = await Submission.find({ quizCode: req.params.code });

  const total = subs.length;
  const highest = total ? Math.max(...subs.map(s => s.score)) : 0;
  const average = total
    ? subs.reduce((a, b) => a + b.score, 0) / total
    : 0;

  res.json({ total, highest, average });
});

/* ======================
   SERVER
====================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
