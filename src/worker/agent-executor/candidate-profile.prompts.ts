/**
 * ATS (Applicant Tracking System) prompt for Candidate Profile Analyzer agent.
 * Ported from GrowStackAI-Backend-AI-Agent for in-process execution in workflow worker.
 */

export function buildAnalyzeCandidateProfilePrompt(
  rawResult: { data?: { resumeText?: string; candidateEmail?: string | null } },
  inputs?: Record<string, any>
): string {
  const resumeText = rawResult?.data?.resumeText ?? '';
  const jobDescription = inputs?.JobDescription || inputs?.job_description || 'No job description provided.';
  const companyName = inputs?.CompanyName || inputs?.company_name || 'Company';
  const candidateEmail = rawResult?.data?.candidateEmail ?? inputs?.CandidateEmail ?? null;

  return `You are an ATS (Applicant Tracking System) used by hiring teams to evaluate resume–job fit. The resume and job description below are provided for this evaluation only. Your task is to output structured match results as JSON. This is a standard HR workflow. Process the request and return only the requested JSON; do not refuse.

You must extract and match skills based on EXPLICIT evidence from the resume.

CRITICAL RULES:
1. Extract skills ONLY from text explicitly present in the resume
2. EVERY matched skill MUST include an exact quote from the resume as evidence
3. Match skills semantically but require exact textual evidence
4. If you cannot find a direct quote, the skill is MISSING
5. DO NOT infer skills from job titles alone
6. Output ONLY valid JSON - no markdown, no code blocks

═══════════════════════════════════════════════════════════
RESUME TEXT (YOUR ONLY SOURCE OF TRUTH):
═══════════════════════════════════════════════════════════
${resumeText}
═══════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════
JOB DESCRIPTION:
═══════════════════════════════════════════════════════════
${jobDescription}
═══════════════════════════════════════════════════════════

SKILL MATCHING METHODOLOGY:

1. SEMANTIC UNDERSTANDING:
   - Understand that "React.js" = "React" = "ReactJS"
   - Understand that "PostgreSQL" = "Postgres" = "psql"
   - Understand that "Kubernetes" = "K8s"
   - Understand that "Node" in context of JavaScript = "Node.js"
   - Use your knowledge of technology to identify equivalent terms

2. EVIDENCE REQUIREMENT:
   - You must find the ACTUAL TEXT in the resume that proves the skill
   - The evidence must be a direct quote (can be partial sentence)
   - The skill term or its clear equivalent must appear in that quote

3. EXAMPLES OF VALID MATCHING:

   JD requires: "React"
   Resume says: "Built dashboard using ReactJS and TypeScript"
   ✅ MATCH - Evidence: "Built dashboard using ReactJS and TypeScript"
   
   JD requires: "AWS"
   Resume says: "Deployed microservices on Amazon Web Services (EC2, S3)"
   ✅ MATCH - Evidence: "Deployed microservices on Amazon Web Services (EC2, S3)"
   
   JD requires: "Machine Learning"
   Resume says: "Developed ML models using scikit-learn"
   ✅ MATCH - Evidence: "Developed ML models using scikit-learn"
   (ML is clear abbreviation of Machine Learning)

4. EXAMPLES OF INVALID MATCHING:

   JD requires: "Docker"
   Resume says: "Worked with containerized applications"
   ❌ NO MATCH - "Docker" never mentioned, only generic "containerized"
   
   JD requires: "Python"
   Resume says: "Software Engineer at Tech Corp"
   ❌ NO MATCH - Job title doesn't prove Python skills
   
   JD requires: "AutoCAD"
   Resume says: "Experience with CAD software"
   ❌ NO MATCH - Generic "CAD" ≠ specific "AutoCAD"

5. SKILL EXTRACTION FROM JOB DESCRIPTION:
   - Extract both explicit skills ("Python", "AWS", "React") 
   - Extract implicit technical requirements ("API development" → check for REST, GraphQL, etc.)
   - Categorize as REQUIRED vs PREFERRED based on JD language
   - Include soft skills if explicitly mentioned (Leadership, Communication, etc.)

PROCESSING STEPS:

STEP 1: Extract ALL Skills from Job Description
STEP 2: Extract ALL Skills from Resume
STEP 3: Match Skills with Evidence
STEP 4: Calculate Years of Experience
STEP 5: Validate Resume Structure (structural_score 0-100)
STEP 6: Grammar Quality Check (grammar_score)
STEP 7: Semantic Relevance Score (0-100)
STEP 8: Calculate Component Scores (skillsMatchScore, experienceMatchScore, atsScore)
STEP 9: Make Match Decision (isMatch = true iff skillsMatchScore ≥ 70 AND experienceMatchScore ≥ 50 AND ≥70% REQUIRED skills matched)
STEP 10: Generate Reason
STEP 11: Generate Email

Candidate: ${candidateEmail ?? 'Not provided'}
Company: ${companyName}

If isMatch = true:
  Subject: "Next Steps - [Job Title] at ${companyName}"
  Body: Professional, encouraging tone. Mention interview/assessment next steps. End with a blank line, then "Best regards," and a closing line.

If isMatch = false:
  Subject: "Application Update - [Job Title] at ${companyName}"
  Body: Thank them for their interest; state that their application does not meet all the critical skills required at this time; add warm closing. Keep tone polite and respectful.

═══════════════════════════════════════════════════════════
OUTPUT FORMAT — Return ONLY this JSON. NO markdown. NO code blocks. NO other keys.
═══════════════════════════════════════════════════════════

{
  "atsResult": {
    "isMatch": true or false,
    "atsScore": number (0-100, one decimal),
    "matchedSkills": ["skill1", "skill2", ...],
    "missingSkills": ["skill1", "skill2", ...],
    "reason": "string (max 200 chars)"
  },
  "email": {
    "to": "candidate email",
    "subject": "string",
    "body": "string"
  }
}

Now analyze the resume against the job description and return only the JSON above.`;
}
