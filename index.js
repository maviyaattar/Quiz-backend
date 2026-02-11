const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

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
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ======================
DB CONNECT
====================== */
mongoose.connect(MONGO_URI)
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
  duration: Number,
  creatorId: mongoose.Schema.Types.ObjectId,

  orgName: String,
  logoUrl: String,
  negativeMarking: { type: Boolean, default: false },

  status: { type: String, default: "created" },
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
CREATE QUIZ
====================== */

app.post("/api/quiz/create", auth, async (req, res) => {
  const { title, description, duration, questions, orgName, logoUrl, negativeMarking } = req.body;

  if (!title || !questions?.length)
    return res.status(400).json({ msg: "Invalid data" });

  const quiz = await Quiz.create({
    code: generateCode(),
    title,
    description,
    duration,
    creatorId: req.user.id,
    questions,
    orgName,
    logoUrl,
    negativeMarking
  });

  res.json(quiz);
});

/* ======================
ALL YOUR OLD ROUTES KEPT SAME
====================== */

app.get("/api/quiz/my", auth, async (req, res) => {
  const quizzes = await Quiz.find({ creatorId: req.user.id })
    .select("code title description status createdAt");
  res.json(quizzes);
});

app.get("/api/quiz/:code", auth, async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (quiz.creatorId.toString() !== req.user.id)
    return res.status(403).json({ msg: "Access denied" });

  res.json(quiz);
});

app.post("/api/quiz/start/:code", auth, async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
  if (quiz.creatorId.toString() !== req.user.id)
    return res.status(403).json({ msg: "Not your quiz" });

  quiz.status = "live";
  quiz.startTime = new Date();
  quiz.endTime = new Date(Date.now() + quiz.duration * 1000);

  await quiz.save();
  res.json({ msg: "Quiz started", endTime: quiz.endTime });
});

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
PARTICIPANT
====================== */

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

/* ======================
SUBMIT + PDF
====================== */

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
    else if (quiz.negativeMarking) score -= 0.25;
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

  const fileName = `Result-${rollNo}-${quiz.code}.pdf`;
  const filePath = path.join(__dirname, fileName);
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(filePath));

  doc.fontSize(18).text("Quiz Result Report", { align: "center" });
  doc.moveDown();

  if (quiz.orgName) doc.text(`Organization: ${quiz.orgName}`);
  doc.text(`Name: ${name}`);
  doc.text(`Roll No: ${rollNo}`);
  doc.text(`Score: ${score}/${quiz.questions.length}`);
  doc.moveDown();

  quiz.questions.forEach((q, i) => {
    const correct = answers[i] === q.correctIndex;
    doc.text(`Q${i + 1}: ${q.text}`);
    doc.text(`Your Answer: ${q.options[answers[i]]}`);
    doc.text(`Correct Answer: ${q.options[q.correctIndex]}`);
    doc.text(correct ? "✔ Correct" : "❌ Incorrect");
    doc.moveDown();
  });

  doc.end();

  doc.on("finish", () => {
    res.download(filePath, fileName, () => {
      fs.unlinkSync(filePath);
    });
  });
});

/* ======================
LEADERBOARD & SUMMARY
====================== */

app.get("/api/quiz/leaderboard/:code", async (req, res) => {
  const data = await Submission.find({ quizCode: req.params.code })
    .sort({ score: -1, submittedAt: 1 })
    .select("name rollNo score");
  res.json(data);
});

app.get("/api/quiz/summary/:code", async (req, res) => {
  const subs = await Submission.find({ quizCode: req.params.code });

  const total = subs.length;
  const highest = total ? Math.max(...subs.map(s => s.score)) : 0;
  const average = total
    ? subs.reduce((a, b) => a + b.score, 0) / total
    : 0;

  res.json({ total, highest, average });
});

app.get("/api/auth/me", auth, async (req, res) => {
  const creator = await Creator.findById(req.user.id).select("name email");
  res.json(creator);
});

/* ======================
SERVER
====================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
