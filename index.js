const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const axios = require("axios");

const app = express();

/* ======================
CONFIG (RAILWAY)
====================== */
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;

// AI Generation Configuration
const AI_MODEL = "llama-3.1-8b-instant";
const AI_TEMPERATURE = 0.7;
const AI_MAX_TOKENS = 4096;

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dgt4rfzqb",
  api_key: process.env.CLOUDINARY_API_KEY || "654113358245137",
  api_secret: process.env.CLOUDINARY_API_SECRET || "PvU8z3ZRF8ciW_F-XD7TOcYSEnE"
});

/* ======================
MIDDLEWARE
====================== */
app.use(cors({ origin: "*" }));
app.use(express.json());

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  }
});

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
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ msg: "All fields are required" });
    }

    if (await Creator.findOne({ email }))
      return res.status(400).json({ msg: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    await Creator.create({ name, email, password: hashed });

    res.json({ msg: "Registered successfully" });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ msg: "Server error during registration" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    const creator = await Creator.findOne({ email });
    if (!creator) return res.status(400).json({ msg: "Invalid credentials" });

    const ok = await bcrypt.compare(password, creator.password);
    if (!ok) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ id: creator._id }, JWT_SECRET, { expiresIn: "1d" });
    res.json({ token, name: creator.name });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ msg: "Server error during login" });
  }
});

/* ======================
LOGO UPLOAD
====================== */

app.post("/api/upload-logo", auth, upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ msg: "No file uploaded" });
    }

    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: "quiz-logos",
          resource_type: "image"
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({
      msg: "Logo uploaded successfully",
      url: result.secure_url,
      publicId: result.public_id
    });
  } catch (error) {
    console.error("Logo upload error:", error);
    res.status(500).json({ msg: "Failed to upload logo", error: error.message });
  }
});

/* ======================
CREATE QUIZ
====================== */

app.post("/api/quiz/create", auth, async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Quiz creation error:", error);
    res.status(500).json({ msg: "Failed to create quiz", error: error.message });
  }
});

/* ======================
AI QUIZ GENERATION
====================== */

app.post("/api/quiz/generate-ai", auth, async (req, res) => {
  try {
    // Extract with defaults using nullish coalescing
    const { topic, difficulty = "medium", numQuestions = 10 } = req.body;
    
    // Validation - topic
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return res.status(400).json({ msg: "Topic is required and must be a non-empty string" });
    }
    
    // Sanitize topic - limit length, trim, and check for prompt injection patterns
    const sanitizedTopic = topic.trim().substring(0, 200);
    
    // Basic prompt injection prevention - reject topics with suspicious patterns
    const suspiciousPatterns = [
      /ignore\s+(previous|all|above)\s+instructions?/i,
      /disregard\s+(previous|all|above)/i,
      /forget\s+(previous|all|above)/i,
      /new\s+instructions?:/i,
      /system\s*:/i,
      /assistant\s*:/i
    ];
    
    const hasSuspiciousPattern = suspiciousPatterns.some(pattern => pattern.test(sanitizedTopic));
    if (hasSuspiciousPattern) {
      return res.status(400).json({ msg: "Topic contains invalid content" });
    }
    
    // Validation - numQuestions
    if (typeof numQuestions !== "number" || !Number.isInteger(numQuestions) || numQuestions < 1 || numQuestions > 50) {
      return res.status(400).json({ msg: "Number of questions must be an integer between 1 and 50" });
    }
    
    // Validation - difficulty
    if (typeof difficulty !== "string") {
      return res.status(400).json({ msg: "Difficulty must be a string" });
    }
    
    const validDifficulties = ["easy", "medium", "hard"];
    const normalizedDifficulty = difficulty.toLowerCase();
    if (!validDifficulties.includes(normalizedDifficulty)) {
      return res.status(400).json({ msg: "Difficulty must be easy, medium, or hard" });
    }
    
    // Check if GROQ_API_KEY is configured
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ msg: "AI service not configured" });
    }
    
    // Construct prompt for Groq using sanitized topic
    const prompt = `Generate ${numQuestions} ${normalizedDifficulty} difficulty multiple-choice questions about: ${sanitizedTopic}. 

Return ONLY a JSON array in this exact format:
[
  {
    "text": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndex": 0
  }
]

Requirements:
- Exactly 4 options per question
- correctIndex is 0-3 (index of correct answer)
- Questions should be clear and unambiguous
- Return ONLY the JSON array, no other text`;

    // Make API call to Groq
    const groqResponse = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: AI_MODEL,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: AI_TEMPERATURE,
        max_tokens: AI_MAX_TOKENS
      },
      {
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    // Extract content from Groq response
    const content = groqResponse.data?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(500).json({ msg: "Failed to generate questions - empty response" });
    }
    
    // Parse JSON from content (handle potential markdown code blocks)
    let questionsArray;
    try {
      // Try to extract JSON from markdown code blocks if present
      let jsonString = content.trim();
      
      // Remove markdown code block markers if present
      if (jsonString.startsWith("```json")) {
        jsonString = jsonString.replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      } else if (jsonString.startsWith("```")) {
        jsonString = jsonString.replace(/^```\s*/, "").replace(/```\s*$/, "");
      }
      
      questionsArray = JSON.parse(jsonString);
    } catch (parseError) {
      console.error("Failed to parse Groq response - invalid JSON format");
      return res.status(500).json({ 
        msg: "Failed to parse AI response",
        error: parseError.message 
      });
    }
    
    // Validate that we got an array
    if (!Array.isArray(questionsArray)) {
      return res.status(500).json({ msg: "AI response is not a valid array" });
    }
    
    // Validate each question
    const validatedQuestions = [];
    for (let i = 0; i < questionsArray.length; i++) {
      const q = questionsArray[i];
      
      // Check required fields
      if (!q.text || typeof q.text !== "string") {
        console.error(`Question ${i + 1} missing or invalid text field`);
        continue;
      }
      
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        console.error(`Question ${i + 1} must have exactly 4 options`);
        continue;
      }
      
      // Validate each option is a non-empty string
      const validOptions = q.options.every(opt => typeof opt === "string" && opt.trim().length > 0);
      if (!validOptions) {
        console.error(`Question ${i + 1} has invalid options - all options must be non-empty strings`);
        continue;
      }
      
      if (typeof q.correctIndex !== "number" || q.correctIndex < 0 || q.correctIndex > 3) {
        console.error(`Question ${i + 1} has invalid correctIndex`);
        continue;
      }
      
      validatedQuestions.push({
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex
      });
    }
    
    if (validatedQuestions.length === 0) {
      return res.status(500).json({ msg: "No valid questions generated" });
    }
    
    // Return successful response
    res.json({
      success: true,
      questions: validatedQuestions
    });
    
  } catch (error) {
    console.error("AI generation error:", error);
    
    // Handle specific error types
    if (error.response) {
      // Groq API error
      const status = error.response.status;
      const message = error.response.data?.error?.message || "AI service error";
      
      if (status === 401) {
        return res.status(500).json({ msg: "AI service authentication failed" });
      } else if (status === 429) {
        return res.status(429).json({ msg: "AI service rate limit exceeded, please try again later" });
      } else {
        return res.status(500).json({ msg: message });
      }
    }
    
    res.status(500).json({ 
      msg: "Failed to generate questions", 
      error: error.message 
    });
  }
});

/* ======================
ALL YOUR OLD ROUTES KEPT SAME
====================== */

app.get("/api/quiz/my", auth, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ creatorId: req.user.id })
      .select("code title description status createdAt");
    res.json(quizzes);
  } catch (error) {
    console.error("Fetch quizzes error:", error);
    res.status(500).json({ msg: "Failed to fetch quizzes" });
  }
});

app.get("/api/quiz/:code", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (quiz.creatorId.toString() !== req.user.id)
      return res.status(403).json({ msg: "Access denied" });

    res.json(quiz);
  } catch (error) {
    console.error("Fetch quiz error:", error);
    res.status(500).json({ msg: "Failed to fetch quiz" });
  }
});

app.post("/api/quiz/start/:code", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (quiz.creatorId.toString() !== req.user.id)
      return res.status(403).json({ msg: "Not your quiz" });

    quiz.status = "live";
    quiz.startTime = new Date();
    quiz.endTime = new Date(Date.now() + quiz.duration * 1000);

    await quiz.save();
    res.json({ msg: "Quiz started", endTime: quiz.endTime });
  } catch (error) {
    console.error("Start quiz error:", error);
    res.status(500).json({ msg: "Failed to start quiz" });
  }
});

app.delete("/api/quiz/delete/:code", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (quiz.creatorId.toString() !== req.user.id)
      return res.status(403).json({ msg: "Not your quiz" });

    await Quiz.deleteOne({ code: quiz.code });
    await Submission.deleteMany({ quizCode: quiz.code });

    res.json({ msg: "Quiz deleted" });
  } catch (error) {
    console.error("Delete quiz error:", error);
    res.status(500).json({ msg: "Failed to delete quiz" });
  }
});

/* ======================
PARTICIPANT
====================== */

app.post("/api/quiz/join/:code", async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Join quiz error:", error);
    res.status(500).json({ msg: "Failed to join quiz" });
  }
});

app.get("/api/quiz/questions/:code", async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz || quiz.status !== "live")
      return res.status(400).json({ msg: "Quiz not live" });

    res.json({
      endTime: quiz.endTime,
      orgName: quiz.orgName,
      logoUrl: quiz.logoUrl,
      questions: quiz.questions.map(q => ({
        text: q.text,
        options: q.options
      }))
    });
  } catch (error) {
    console.error("Fetch questions error:", error);
    res.status(500).json({ msg: "Failed to fetch questions" });
  }
});

/* ======================
SUBMIT + PDF
====================== */

// Helper function to fetch image from URL and return as buffer
async function fetchImageAsBuffer(url) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Failed to fetch image:", error.message);
    return null;
  }
}

// Helper function to get performance rating
function getPerformanceRating(percentage) {
  if (percentage >= 90) return "Excellent";
  if (percentage >= 70) return "Good";
  if (percentage >= 50) return "Average";
  return "Needs Improvement";
}

// Helper function to calculate quiz statistics
function calculateQuizStatistics(quiz, submission) {
  let correctAnswers = 0;
  let incorrectAnswers = 0;
  
  quiz.questions.forEach((q, i) => {
    if (submission.answers[i] === q.correctIndex) {
      correctAnswers++;
    } else if (submission.answers[i] !== undefined) {
      incorrectAnswers++;
    }
  });
  
  return { correctAnswers, incorrectAnswers };
}

app.post("/api/quiz/submit/:code", async (req, res) => {
  try {
    const { name, branch, rollNo, answers } = req.body;
    const quiz = await Quiz.findOne({ code: req.params.code });

    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (Date.now() > quiz.endTime)
      return res.status(400).json({ msg: "Time over" });

    if (await Submission.findOne({ quizCode: quiz.code, rollNo }))
      return res.status(400).json({ msg: "Already submitted" });

    // Calculate score
    let score = 0;
    let correctAnswers = 0;
    let incorrectAnswers = 0;

    quiz.questions.forEach((q, i) => {
      if (answers[i] === q.correctIndex) {
        score++;
        correctAnswers++;
      } else if (quiz.negativeMarking) {
        score -= 0.25;
        incorrectAnswers++;
      } else {
        incorrectAnswers++;
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

    // Enhanced PDF Generation
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers for PDF download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Result-${rollNo}-${quiz.code}.pdf`
    );

    // Stream directly to response
    doc.pipe(res);

    // Calculate percentage
    const percentage = ((score / quiz.questions.length) * 100).toFixed(2);
    const performanceRating = getPerformanceRating(percentage);

    // Page setup
    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const contentWidth = pageWidth - 2 * margin;

    // ============ PROFESSIONAL HEADER ============
    let yPosition = 50;

    // Try to add logo if available
    if (quiz.logoUrl) {
      try {
        const logoBuffer = await fetchImageAsBuffer(quiz.logoUrl);
        if (logoBuffer) {
          doc.image(logoBuffer, margin, yPosition, { width: 80, height: 80 });
          
          // Organization name and quiz title next to logo
          doc.fontSize(20).font("Helvetica-Bold")
            .text(quiz.orgName || "Quiz Report", margin + 100, yPosition, { width: contentWidth - 100 });
          doc.fontSize(16).font("Helvetica")
            .text(quiz.title, margin + 100, yPosition + 30, { width: contentWidth - 100 });
          
          yPosition += 100;
        } else {
          // Logo fetch failed, use text only
          doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
            .text(quiz.orgName || "Quiz Report", { align: "center" });
          doc.fontSize(18).font("Helvetica").fillColor("#34495e")
            .text(quiz.title, { align: "center" });
          yPosition += 80;
        }
      } catch (err) {
        console.error("Error adding logo to PDF:", err);
        // Fallback to text only
        doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
          .text(quiz.orgName || "Quiz Report", { align: "center" });
        doc.fontSize(18).font("Helvetica").fillColor("#34495e")
          .text(quiz.title, { align: "center" });
        yPosition += 80;
      }
    } else {
      // No logo, use text only
      doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
        .text(quiz.orgName || "Quiz Report", { align: "center" });
      doc.fontSize(18).font("Helvetica").fillColor("#34495e")
        .text(quiz.title, { align: "center" });
      yPosition += 80;
    }

    // Date and time
    doc.fontSize(10).font("Helvetica").fillColor("#7f8c8d")
      .text(`Generated on: ${new Date().toLocaleString()}`, { align: "center" });
    
    yPosition += 30;
    doc.moveTo(margin, yPosition).lineTo(pageWidth - margin, yPosition).stroke("#bdc3c7");
    yPosition += 30;

    // ============ STUDENT INFORMATION CARD ============
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Student Information", margin, yPosition);
    yPosition += 20;

    // Draw a box for student info
    doc.rect(margin, yPosition, contentWidth, 100).fillAndStroke("#ecf0f1", "#bdc3c7");
    yPosition += 15;

    doc.fontSize(12).font("Helvetica").fillColor("#2c3e50")
      .text(`Name: ${name}`, margin + 15, yPosition);
    yPosition += 20;
    doc.text(`Roll No: ${rollNo}`, margin + 15, yPosition);
    yPosition += 20;
    doc.text(`Branch: ${branch}`, margin + 15, yPosition);
    yPosition += 20;
    
    // Score with visual indicator
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#27ae60")
      .text(`Score: ${score}/${quiz.questions.length} (${percentage}%)`, margin + 15, yPosition);
    
    yPosition += 40;

    // ============ DETAILED RESULTS SECTION ============
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Detailed Results", margin, yPosition);
    yPosition += 20;

    quiz.questions.forEach((q, i) => {
      // Check if we need a new page
      if (yPosition > doc.page.height - 200) {
        doc.addPage();
        yPosition = 50;
      }

      const isCorrect = answers[i] === q.correctIndex;
      
      // Question box
      doc.rect(margin, yPosition, contentWidth, 10).fillAndStroke(isCorrect ? "#d5f4e6" : "#fadbd8", "#bdc3c7");
      yPosition += 15;

      // Question number and text
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#2c3e50")
        .text(`Q${i + 1}. ${q.text}`, margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += doc.heightOfString(`Q${i + 1}. ${q.text}`, { width: contentWidth - 20 }) + 5;

      // Your answer
      doc.fontSize(10).font("Helvetica").fillColor(isCorrect ? "#27ae60" : "#e74c3c")
        .text(`Your Answer: ${answers[i] !== undefined ? q.options[answers[i]] || "Not answered" : "Not answered"}`, 
              margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += 15;

      // Correct answer
      doc.fontSize(10).font("Helvetica").fillColor("#2c3e50")
        .text(`Correct Answer: ${q.options[q.correctIndex]}`, margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += 15;

      // Status indicator
      doc.fontSize(10).font("Helvetica-Bold").fillColor(isCorrect ? "#27ae60" : "#e74c3c")
        .text(isCorrect ? "✓ Correct" : "✗ Incorrect", margin + 10, yPosition);
      yPosition += 25;
    });

    // ============ SUMMARY FOOTER ============
    if (yPosition > doc.page.height - 250) {
      doc.addPage();
      yPosition = 50;
    }

    yPosition += 20;
    doc.moveTo(margin, yPosition).lineTo(pageWidth - margin, yPosition).stroke("#bdc3c7");
    yPosition += 20;

    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Summary", margin, yPosition);
    yPosition += 20;

    // Summary box
    doc.rect(margin, yPosition, contentWidth, 120).fillAndStroke("#ecf0f1", "#bdc3c7");
    yPosition += 15;

    doc.fontSize(12).font("Helvetica").fillColor("#2c3e50")
      .text(`Total Questions: ${quiz.questions.length}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#27ae60")
      .text(`Correct Answers: ${correctAnswers}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#e74c3c")
      .text(`Incorrect Answers: ${incorrectAnswers}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#2c3e50")
      .text(`Percentage: ${percentage}%`, margin + 15, yPosition);
    yPosition += 20;
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#3498db")
      .text(`Performance Rating: ${performanceRating}`, margin + 15, yPosition);

    doc.end();

    // Handle PDF generation errors during streaming
    // Note: If error occurs after piping starts, response headers are already sent
    // so we can only log the error. The client will receive an incomplete/corrupted PDF.
    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      if (!res.headersSent) {
        res.status(500).json({ msg: "Failed to generate PDF" });
      }
    });

  } catch (error) {
    console.error("Submit quiz error:", error);
    if (!res.headersSent) {
      res.status(500).json({ msg: "Failed to submit quiz", error: error.message });
    }
  }
});

/* ======================
LEADERBOARD & SUMMARY
====================== */

app.get("/api/quiz/leaderboard/:code", async (req, res) => {
  try {
    const data = await Submission.find({ quizCode: req.params.code })
      .sort({ score: -1, submittedAt: 1 })
      .select("name rollNo score");
    res.json(data);
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ msg: "Failed to fetch leaderboard" });
  }
});

app.get("/api/quiz/summary/:code", async (req, res) => {
  try {
    const subs = await Submission.find({ quizCode: req.params.code });

    const total = subs.length;
    const highest = total ? Math.max(...subs.map(s => s.score)) : 0;
    const average = total
      ? subs.reduce((a, b) => a + b.score, 0) / total
      : 0;

    res.json({ total, highest, average });
  } catch (error) {
    console.error("Summary error:", error);
    res.status(500).json({ msg: "Failed to fetch summary" });
  }
});

app.get("/api/quiz/participants/:code", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ code: req.params.code });
    
    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (quiz.creatorId.toString() !== req.user.id)
      return res.status(403).json({ msg: "Access denied" });

    const participants = await Submission.find({ quizCode: req.params.code })
      .select("name rollNo branch score submittedAt answers")
      .sort({ submittedAt: -1 });
    
    res.json(participants);
  } catch (error) {
    console.error("Participants error:", error);
    res.status(500).json({ msg: "Failed to fetch participants" });
  }
});

app.get("/api/quiz/participant-pdf/:code/:rollNo", auth, async (req, res) => {
  try {
    const { code, rollNo } = req.params;
    
    const quiz = await Quiz.findOne({ code });
    if (!quiz) return res.status(404).json({ msg: "Quiz not found" });
    if (quiz.creatorId.toString() !== req.user.id)
      return res.status(403).json({ msg: "Access denied" });

    const submission = await Submission.findOne({ quizCode: code, rollNo });
    if (!submission) return res.status(404).json({ msg: "Submission not found" });

    // Calculate stats using helper function
    const { correctAnswers, incorrectAnswers } = calculateQuizStatistics(quiz, submission);

    // Generate PDF (reuse existing PDF generation code from submit endpoint)
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers for PDF download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Result-${rollNo}-${code}.pdf`
    );

    // Stream directly to response
    doc.pipe(res);

    const percentage = ((submission.score / quiz.questions.length) * 100).toFixed(2);
    const performanceRating = getPerformanceRating(percentage);
    
    // Page setup
    const pageWidth = doc.page.width;
    const margin = doc.page.margins.left;
    const contentWidth = pageWidth - 2 * margin;

    // ============ PROFESSIONAL HEADER ============
    let yPosition = 50;

    // Try to add logo if available
    if (quiz.logoUrl) {
      try {
        const logoBuffer = await fetchImageAsBuffer(quiz.logoUrl);
        if (logoBuffer) {
          doc.image(logoBuffer, margin, yPosition, { width: 80, height: 80 });
          
          // Organization name and quiz title next to logo
          doc.fontSize(20).font("Helvetica-Bold")
            .text(quiz.orgName || "Quiz Report", margin + 100, yPosition, { width: contentWidth - 100 });
          doc.fontSize(16).font("Helvetica")
            .text(quiz.title, margin + 100, yPosition + 30, { width: contentWidth - 100 });
          
          yPosition += 100;
        } else {
          // Logo fetch failed, use text only
          doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
            .text(quiz.orgName || "Quiz Report", { align: "center" });
          doc.fontSize(18).font("Helvetica").fillColor("#34495e")
            .text(quiz.title, { align: "center" });
          yPosition += 80;
        }
      } catch (err) {
        console.error("Error adding logo to PDF:", err);
        // Fallback to text only
        doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
          .text(quiz.orgName || "Quiz Report", { align: "center" });
        doc.fontSize(18).font("Helvetica").fillColor("#34495e")
          .text(quiz.title, { align: "center" });
        yPosition += 80;
      }
    } else {
      // No logo, use text only
      doc.fontSize(22).font("Helvetica-Bold").fillColor("#2c3e50")
        .text(quiz.orgName || "Quiz Report", { align: "center" });
      doc.fontSize(18).font("Helvetica").fillColor("#34495e")
        .text(quiz.title, { align: "center" });
      yPosition += 80;
    }

    // Date and time
    doc.fontSize(10).font("Helvetica").fillColor("#7f8c8d")
      .text(`Generated on: ${new Date().toLocaleString()}`, { align: "center" });
    
    yPosition += 30;
    doc.moveTo(margin, yPosition).lineTo(pageWidth - margin, yPosition).stroke("#bdc3c7");
    yPosition += 30;

    // ============ STUDENT INFORMATION CARD ============
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Student Information", margin, yPosition);
    yPosition += 20;

    // Draw a box for student info
    doc.rect(margin, yPosition, contentWidth, 100).fillAndStroke("#ecf0f1", "#bdc3c7");
    yPosition += 15;

    doc.fontSize(12).font("Helvetica").fillColor("#2c3e50")
      .text(`Name: ${submission.name}`, margin + 15, yPosition);
    yPosition += 20;
    doc.text(`Roll No: ${submission.rollNo}`, margin + 15, yPosition);
    yPosition += 20;
    doc.text(`Branch: ${submission.branch}`, margin + 15, yPosition);
    yPosition += 20;
    
    // Score with visual indicator
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#27ae60")
      .text(`Score: ${submission.score}/${quiz.questions.length} (${percentage}%)`, margin + 15, yPosition);
    
    yPosition += 40;

    // ============ DETAILED RESULTS SECTION ============
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Detailed Results", margin, yPosition);
    yPosition += 20;

    quiz.questions.forEach((q, i) => {
      // Check if we need a new page
      if (yPosition > doc.page.height - 200) {
        doc.addPage();
        yPosition = 50;
      }

      const isCorrect = submission.answers[i] === q.correctIndex;
      const isAnswered = submission.answers[i] !== undefined;
      
      // Question box - different color for correct, incorrect, and unanswered
      const boxColor = isAnswered ? (isCorrect ? "#d5f4e6" : "#fadbd8") : "#f0f0f0";
      doc.rect(margin, yPosition, contentWidth, 10).fillAndStroke(boxColor, "#bdc3c7");
      yPosition += 15;

      // Question number and text
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#2c3e50")
        .text(`Q${i + 1}. ${q.text}`, margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += doc.heightOfString(`Q${i + 1}. ${q.text}`, { width: contentWidth - 20 }) + 5;

      // Your answer
      const userAnswer = isAnswered && q.options[submission.answers[i]] 
        ? q.options[submission.answers[i]] 
        : "Not answered";
      const answerColor = isAnswered ? (isCorrect ? "#27ae60" : "#e74c3c") : "#95a5a6";
      doc.fontSize(10).font("Helvetica").fillColor(answerColor)
        .text(`Your Answer: ${userAnswer}`, margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += 15;

      // Correct answer
      doc.fontSize(10).font("Helvetica").fillColor("#2c3e50")
        .text(`Correct Answer: ${q.options[q.correctIndex]}`, margin + 10, yPosition, { width: contentWidth - 20 });
      yPosition += 15;

      // Status indicator
      let statusText, statusColor;
      if (!isAnswered) {
        statusText = "- Not Answered";
        statusColor = "#95a5a6";
      } else if (isCorrect) {
        statusText = "✓ Correct";
        statusColor = "#27ae60";
      } else {
        statusText = "✗ Incorrect";
        statusColor = "#e74c3c";
      }
      doc.fontSize(10).font("Helvetica-Bold").fillColor(statusColor)
        .text(statusText, margin + 10, yPosition);
      yPosition += 25;
    });

    // ============ SUMMARY FOOTER ============
    if (yPosition > doc.page.height - 250) {
      doc.addPage();
      yPosition = 50;
    }

    yPosition += 20;
    doc.moveTo(margin, yPosition).lineTo(pageWidth - margin, yPosition).stroke("#bdc3c7");
    yPosition += 20;

    doc.fontSize(14).font("Helvetica-Bold").fillColor("#2c3e50")
      .text("Summary", margin, yPosition);
    yPosition += 20;

    // Summary box
    doc.rect(margin, yPosition, contentWidth, 120).fillAndStroke("#ecf0f1", "#bdc3c7");
    yPosition += 15;

    doc.fontSize(12).font("Helvetica").fillColor("#2c3e50")
      .text(`Total Questions: ${quiz.questions.length}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#27ae60")
      .text(`Correct Answers: ${correctAnswers}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#e74c3c")
      .text(`Incorrect Answers: ${incorrectAnswers}`, margin + 15, yPosition);
    yPosition += 20;
    doc.fillColor("#2c3e50")
      .text(`Percentage: ${percentage}%`, margin + 15, yPosition);
    yPosition += 20;
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#3498db")
      .text(`Performance Rating: ${performanceRating}`, margin + 15, yPosition);

    doc.end();

    // Handle PDF generation errors during streaming
    // Note: If error occurs after piping starts, response headers are already sent
    // so we can only log the error. The client will receive an incomplete/corrupted PDF.
    doc.on("error", (err) => {
      console.error("PDF generation error:", err);
      if (!res.headersSent) {
        res.status(500).json({ msg: "Failed to generate PDF" });
      }
    });

  } catch (error) {
    console.error("PDF download error:", error);
    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).json({ msg: "Failed to download PDF", error: error.message });
    }
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const creator = await Creator.findById(req.user.id).select("name email");
    res.json(creator);
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ msg: "Failed to fetch user data" });
  }
});

/* ======================
SERVER
====================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
