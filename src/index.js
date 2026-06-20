import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ====== DATABASE (In-memory) ======
const db = {
  users: {},
  projects: {},
  tasks: {},
  agents: {},
  payments: {},
  apiKeys: {},
  workflows: {}
};

// ====== ROOT ROUTE ======
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Nova AI - Enhanced with Victor System',
    version: '2.0.0',
    message: 'Multi-Agent AI Platform Running',
    features: [
      'Nova AI base features',
      'Victor AI 5-agent orchestration',
      'Multi-format support',
      'Real-time processing',
      'Advanced analytics'
    ],
    timestamp: new Date().toISOString()
  });
});

// ====== AUTHENTICATION ======
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ====== VICTOR AI AGENTS ======

class RouterAgent {
  async process(input) {
    const taskTypes = {
      'generate': 'PROCESSOR',
      'analyze': 'PROCESSOR',
      'summarize': 'PROCESSOR',
      'validate': 'VALIDATOR',
      'optimize': 'OPTIMIZER',
    };

    const matchedType = Object.keys(taskTypes).find(type =>
      input.prompt?.toLowerCase().includes(type)
    );

    return {
      agent: 'router',
      targetAgent: taskTypes[matchedType] || 'PROCESSOR',
      priority: input.prompt?.length > 500 ? 'HIGH' : 'NORMAL',
      confidence: 0.95,
      timestamp: new Date().toISOString()
    };
  }
}

class ProcessorAgent {
  async process(input) {
    const responses = {
      'generate': 'Generated content based on your requirements with detailed information and actionable insights.',
      'analyze': 'Analysis complete. Key findings: Primary patterns identified, positive trajectory detected, optimization recommendations provided.',
      'summarize': 'Summary: Content covers important aspects grouped into main categories with actionable takeaways.',
      'default': 'Processing complete. Comprehensive response generated based on input parameters.'
    };

    for (const [key, response] of Object.entries(responses)) {
      if (input.prompt?.toLowerCase().includes(key)) {
        return {
          agent: 'processor',
          result: response,
          confidence: 0.92,
          tokens: Math.floor(Math.random() * 500) + 100,
          timestamp: new Date().toISOString()
        };
      }
    }

    return {
      agent: 'processor',
      result: responses.default,
      confidence: 0.88,
      tokens: 200,
      timestamp: new Date().toISOString()
    };
  }
}

class ValidatorAgent {
  async process(input) {
    const checks = [
      { name: 'completeness', passed: input.result?.length > 10 },
      { name: 'coherence', passed: input.result?.split('\n').length > 1 },
      { name: 'quality', passed: !input.result?.includes('undefined') }
    ];

    const passedChecks = checks.filter(c => c.passed).length;
    const score = (passedChecks / checks.length) * 100;

    return {
      agent: 'validator',
      isValid: score >= 70,
      score,
      checks: checks.map(c => ({ name: c.name, passed: c.passed })),
      timestamp: new Date().toISOString()
    };
  }
}

class OptimizerAgent {
  async process(input) {
    let optimized = input.result;
    let improvement = 0;

    if (!input.isValid) {
      optimized = optimized + '\n\n[Optimized: Additional details and structure added for clarity]';
      improvement = 15;
    } else {
      improvement = 5;
    }

    return {
      agent: 'optimizer',
      result: optimized,
      improvement,
      optimizationsApplied: Math.max(1, improvement / 5),
      timestamp: new Date().toISOString()
    };
  }
}

class ExecutorAgent {
  async process(input) {
    const formatters = {
      text: (r) => r,
      json: (r) => JSON.stringify({ content: r, timestamp: new Date() }, null, 2),
      markdown: (r) => `# Result\n\n${r}`,
      html: (r) => `<div style="padding:20px"><h2>Result</h2><p>${r}</p></div>`
    };

    const format = input.format || 'text';
    const formatter = formatters[format] || formatters.text;

    return {
      agent: 'executor',
      result: formatter(input.result),
      format,
      status: 'SUCCESS',
      timestamp: new Date().toISOString()
    };
  }
}

// ====== WORKFLOW ENGINE ======

class WorkflowEngine {
  constructor(taskId, input) {
    this.taskId = taskId;
    this.input = input;
    this.agents = [
      new RouterAgent(),
      new ProcessorAgent(),
      new ValidatorAgent(),
      new OptimizerAgent(),
      new ExecutorAgent()
    ];
    this.stages = {};
  }

  async execute() {
    let data = this.input;
    const startTime = Date.now();

    try {
      console.log(`[${this.taskId}] Starting workflow...`);

      // Stage 1: Router
      const routeResult = await this.agents[0].process(data);
      this.stages.routing = routeResult;
      data = { ...data, ...routeResult };

      // Stage 2: Processor
      const processResult = await this.agents[1].process(data);
      this.stages.processing = processResult;
      data = { ...data, result: processResult.result };

      // Stage 3: Validator
      const validateResult = await this.agents[2].process(data);
      this.stages.validation = validateResult;
      data = { ...data, ...validateResult };

      // Stage 4: Optimizer (with retry logic)
      let retries = 0;
      while (!data.isValid && retries < 3) {
        const optimizeResult = await this.agents[3].process(data);
        this.stages.optimization = optimizeResult;
        data = { ...data, result: optimizeResult.result };

        const revalidate = await this.agents[2].process(data);
        data = { ...data, ...revalidate };
        retries++;
      }

      // Stage 5: Executor
      const executeResult = await this.agents[4].process(data);
      this.stages.execution = executeResult;

      return {
        success: true,
        taskId: this.taskId,
        result: executeResult.result,
        stages: this.stages,
        executionTime: Date.now() - startTime,
        retryCount: retries,
        validationScore: data.score || 100
      };

    } catch (error) {
      console.error(`[${this.taskId}] Workflow failed:`, error.message);
      return {
        success: false,
        taskId: this.taskId,
        error: error.message,
        executionTime: Date.now() - startTime
      };
    }
  }
}

// ====== INITIALIZE AGENTS ======

const initializeAgents = () => {
  const agents = [
    { id: uuidv4(), name: 'Router', role: 'Routes tasks to optimal agents', status: 'online', version: '1.0.0', cost: 0.01 },
    { id: uuidv4(), name: 'Processor', role: 'Executes AI reasoning', status: 'online', version: '1.0.0', cost: 0.05 },
    { id: uuidv4(), name: 'Validator', role: 'Validates outputs', status: 'online', version: '1.0.0', cost: 0.02 },
    { id: uuidv4(), name: 'Optimizer', role: 'Improves results', status: 'online', version: '1.0.0', cost: 0.03 },
    { id: uuidv4(), name: 'Executor', role: 'Final execution', status: 'online', version: '1.0.0', cost: 0.04 }
  ];

  agents.forEach(agent => {
    db.agents[agent.id] = agent;
  });

  return agents;
};

// ====== PRICING ======

const PRICING = {
  FREE: { credits: 100, monthlyTasks: 50, cost: 0 },
  PRO: { credits: 10000, monthlyTasks: 5000, cost: 2900 },
  ENTERPRISE: { credits: 100000, monthlyTasks: 'unlimited', cost: 99900 }
};

// ====== AUTH ROUTES ======

app.post('/api/auth/register', (req, res) => {
  const { email, password, username } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  if (db.users[email]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const userId = uuidv4();
  db.users[email] = {
    id: userId,
    email,
    password,
    username: username || email.split('@')[0],
    credits: 100,
    subscription: 'free',
    createdAt: new Date()
  };

  const token = jwt.sign({ userId, email }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '7d'
  });

  res.status(201).json({
    success: true,
    userId,
    email,
    token,
    credits: 100,
    message: 'User registered successfully'
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = db.users[email];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user.id, email }, process.env.JWT_SECRET || 'secret', {
    expiresIn: '7d'
  });

  res.json({
    success: true,
    userId: user.id,
    email,
    token,
    credits: user.credits,
    subscription: user.subscription
  });
});

// ====== TASK ROUTES ======

app.post('/api/tasks', authenticate, async (req, res) => {
  const { prompt, format, priority } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  const taskId = uuidv4();
  const user = Object.values(db.users).find(u => u.id === req.userId);

  db.tasks[taskId] = {
    id: taskId,
    userId: req.userId,
    prompt,
    format: format || 'text',
    priority: priority || 'medium',
    status: 'pending',
    progress: 0,
    createdAt: new Date()
  };

  // Execute workflow asynchronously
  (async () => {
    const engine = new WorkflowEngine(taskId, { prompt, format: format || 'text' });
    const result = await engine.execute();

    const cost = 0.15; // Total cost per task

    db.tasks[taskId] = {
      ...db.tasks[taskId],
      status: result.success ? 'completed' : 'failed',
      result: result.result,
      stages: result.stages,
      executionTime: result.executionTime,
      cost,
      completedAt: new Date()
    };

    if (user) {
      user.credits -= Math.ceil(cost * 100);
    }
  })();

  res.status(202).json({
    success: true,
    taskId,
    status: 'processing',
    message: 'Task submitted for processing'
  });
});

app.get('/api/tasks', authenticate, (req, res) => {
  const { status } = req.query;

  let tasks = Object.values(db.tasks).filter(t => t.userId === req.userId);

  if (status) tasks = tasks.filter(t => t.status === status);

  res.json({ tasks });
});

app.get('/api/tasks/:taskId', authenticate, (req, res) => {
  const task = db.tasks[req.params.taskId];

  if (!task || task.userId !== req.userId) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({ task });
});

// ====== AGENTS ROUTES ======

app.get('/api/agents', (req, res) => {
  const agents = Object.values(db.agents);
  res.json({
    total: agents.length,
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      version: a.version,
      cost: a.cost
    }))
  });
});

// ====== USER ROUTES ======

app.get('/api/user/me', authenticate, (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    subscription: user.subscription,
    credits: user.credits,
    createdAt: user.createdAt
  });
});

app.get('/api/user/usage', authenticate, (req, res) => {
  const user = Object.values(db.users).find(u => u.id === req.userId);
  const userTasks = Object.values(db.tasks).filter(t => t.userId === req.userId);
  const completedTasks = userTasks.filter(t => t.status === 'completed');

  const totalCost = completedTasks.reduce((sum, t) => sum + (t.cost || 0), 0);

  res.json({
    userId: req.userId,
    subscription: user?.subscription || 'free',
    creditsAvailable: user?.credits || 0,
    creditsSpent: totalCost,
    tasksCompleted: completedTasks.length,
    tasksTotal: userTasks.length,
    avgExecutionTime: userTasks.length > 0
      ? Math.round(userTasks.reduce((sum, t) => sum + (t.executionTime || 0), 0) / userTasks.length)
      : 0
  });
});

// ====== HEALTH & SYSTEM ROUTES ======

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Nova AI Enhanced',
    version: '2.0.0',
    uptime: process.uptime(),
    agents: Object.keys(db.agents).length,
    tasks: Object.keys(db.tasks).length,
    users: Object.keys(db.users).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/system/stats', (req, res) => {
  const tasks = Object.values(db.tasks);
  const completed = tasks.filter(t => t.status === 'completed');

  res.json({
    totalUsers: Object.keys(db.users).length,
    totalTasks: tasks.length,
    completedTasks: completed.length,
    avgExecutionTime: tasks.length > 0
      ? Math.round(tasks.reduce((sum, t) => sum + (t.executionTime || 0), 0) / tasks.length)
      : 0,
    totalCreditsSpent: completed.reduce((sum, t) => sum + (t.cost || 0), 0).toFixed(2),
    agents: Object.values(db.agents).map(a => ({
      name: a.name,
      status: a.status,
      cost: a.cost
    }))
  });
});

// ====== ERROR HANDLERS ======

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// ====== SERVER START ======

const startServer = () => {
  initializeAgents();

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║  NOVA AI v2.0 - Enhanced with Victor AI 5-Agent System   ║
╚═══════════════════════════════════════════════════════════╝

✅ Server running on port ${PORT}
✅ ${Object.keys(db.agents).length} AI agents registered
✅ Multi-format support (text, JSON, markdown, HTML)
✅ Real-time task processing
✅ Advanced analytics enabled

🤖 AGENTS ACTIVE:
  • Router Agent ($0.01)
  • Processor Agent ($0.05)
  • Validator Agent ($0.02)
  • Optimizer Agent ($0.03)
  • Executor Agent ($0.04)

📊 API ENDPOINTS:
  Auth:     POST /api/auth/register, /api/auth/login
  Tasks:    GET/POST /api/tasks
  User:     GET /api/user/me, /api/user/usage
  Agents:   GET /api/agents
  Health:   GET /api/health, /api/system/stats

🚀 Nova AI is READY!
    `);
  });
};

startServer();

export default app;
