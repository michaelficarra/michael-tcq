import express from 'express';
import session from 'express-session';
import { createServer } from 'node:http';

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-replace-me';

app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // will be true behind Cloud Run's HTTPS termination
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

httpServer.listen(PORT, () => {
  console.log(`TCQ server listening on http://localhost:${PORT}`);
});
