Render deployment instructions (copy-paste into Render UI)

Service 1 — exam-ai-proctor (Python web service)
- Name: exam-ai-proctor
- Type: Web Service
- Environment: Python
- Region: (choose nearest)
- Branch: main
- Root Directory: exam
- Build Command: pip install -r requirements.txt
- Start Command: python ai/processor.py
- Health Check Path: /health
- Environment Variables:
  - FLASK_ENV = production
  - PORT = 5000   # Render will override PORT at runtime, this is fine

Service 2 — exam-backend (Node web service)
- Name: exam-backend
- Type: Web Service
- Environment: Node
- Region: (choose nearest)
- Branch: main
- Root Directory: exam
- Build Command: npm install --production
- Start Command: npm start
- Health Check Path: /api/health (or /)
- Environment Variables (set in Render's UI):
  - MONGO_URI = mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/proctorguard?retryWrites=true&w=majority
  - AI_SERVICE_URL = https://<exam-ai-proctor>.onrender.com
  - JWT_SECRET = <replace-with-secret>
  - ADMIN_SECRET = <replace-with-secret>
  - ALLOWED_ORIGINS = https://<your-vercel-domain>

Notes:
- Do NOT put real DB credentials in `render-deploy.md` — use the Render UI to set env vars securely.
- After both services are deployed, copy the AI service URL into `AI_SERVICE_URL` for the backend.
- Change `ALLOWED_ORIGINS` to your Vercel domain (e.g., https://exam-frontend-xyz.vercel.app). If empty, backend allows all origins.
