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
   CONFIG
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

function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
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
   AUTH
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
   GET QUESTIONS (SHUFFLED)
====================== */

app.get("/api/quiz/questions/:code", async (req, res) => {
  const quiz = await Quiz.findOne({ code: req.params.code });

  if (!quiz || quiz.status !== "live")
    return res.status(400).json({ msg: "Quiz not live" });

  const shuffledQuestions = shuffleArray([...quiz.questions]).map(q => {
    const shuffledOptions = shuffleArray([...q.options]);

    return {
      text: q.text,
      options: shuffledOptions
    };
  });

  res.json({
    endTime: quiz.endTime,
    questions: shuffledQuestions
  });
});

/* ======================
   SUBMIT QUIZ + PDF
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
    if (answers[i] === q.correctIndex) {
      score += 1;
    } else if (quiz.negativeMarking) {
      score -= 0.25;
    }
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

  /* ===== PDF GENERATION ===== */

  const fileName = `Result-${rollNo}-${quiz.code}.pdf`;
  const filePath = path.join(__dirname, fileName);
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(filePath));

  doc.fontSize(18).text("Quiz Result Report", { align: "center" });
  doc.moveDown();

  if (quiz.orgName)
    doc.fontSize(14).text(`Organization: ${quiz.orgName}`);

  doc.text(`Name: ${name}`);
  doc.text(`Roll No: ${rollNo}`);
  doc.text(`Score: ${score}/${quiz.questions.length}`);
  doc.moveDown();

  quiz.questions.forEach((q, i) => {
    const userAnswer = answers[i];
    const correct = userAnswer === q.correctIndex;

    doc.text(`Q${i + 1}: ${q.text}`);
    doc.text(`Your Answer: ${q.options[userAnswer]}`);
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
   SERVER
====================== */

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
