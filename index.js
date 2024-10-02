const express = require('express');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { OpenAI } = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');
const nodemailer = require('nodemailer');
const functions = require('@google-cloud/functions-framework');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors());

// Set up OpenAI and Pinecone API keys
const openai = new OpenAI();
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const indexName = "medicalcodes";
console.log(pc.listIndexes());
const index = pc.Index(indexName);

// Initialize the Secret Manager client
const client = new SecretManagerServiceClient();

async function createSecret(patientId, username, password, ehrType) {
  const projectId = "sinewave-mobile";
  const secretData = JSON.stringify({
    username,
    password,
    ehr_type: ehrType
  });

  const parent = `projects/${projectId}`;

  try {
    const [secret] = await client.createSecret({
      parent,
      secretId: patientId,
      secret: {
        replication: {
          automatic: {}
        }
      }
    });
    console.log(`Created secret: ${secret.name}`);

    const secretName = `projects/${projectId}/secrets/${patientId}`;
    const [version] = await client.addSecretVersion({
      parent: secretName,
      payload: {
        data: Buffer.from(secretData, 'utf-8')
      }
    });

    console.log(`Added secret version: ${version.name}`);
    return version;
  } catch (error) {
    console.error(`Secret creation failed: ${error}`);
    return null;
  }
}

async function fetchCredentials(patientId) {
  const projectId = "sinewave-mobile";
  const secretName = `projects/${projectId}/secrets/${patientId}/versions/latest`;

  try {
    const [version] = await client.accessSecretVersion({ name: secretName });
    const secretPayload = version.payload.data.toString('utf-8');
    const credentials = JSON.parse(secretPayload);
    console.log(`Fetched credentials for patient_id: ${patientId}`);
    return credentials;
  } catch (error) {
    console.error(`Failed to fetch secret: ${error}`);
    return null;
  }
}

app.get('/getCredentials', async (req, res) => {
  const patientId = req.query.patient_id;
  
  if (!patientId) {
    return res.status(400).json({ message: "patient_id is required" });
  }
  
  const credentials = await fetchCredentials(patientId);
  
  if (credentials) {
    res.json(credentials);
  } else {
    res.status(404).json({ message: "Failed to fetch credentials" });
  }
});

app.post('/storeCredentials', async (req, res) => {
  const { username, password, ehr_type, patient_id } = req.body;
  console.log(req.body);

  const response = await createSecret(patient_id, username, password, ehr_type);
  console.log(response);

  res.json({ status: 'success', secret_version_id: response.name });
});

async function getOpenAIEmbeddings(text, model = "text-embedding-ada-002") {
  text = text.replace(/\n/g, " ");
  const response = await openai.embeddings.create({ input: [text], model });
  return response.data[0].embedding;
}

async function queryCodes(queryText, topK) {
  const queryEmbedding = await getOpenAIEmbeddings(queryText);
  const queryResults = await index.query({ vector: queryEmbedding, topK, includeMetadata: true });
  return queryResults.matches.map(match => [match.id, match.score]);
}

app.post('/get_medical_codes', async (req, res) => {
  const { diagnosis } = req.body;
  console.log(diagnosis);

  if (!diagnosis) {
    return res.status(400).json({ error: "No diagnosis text provided" });
  }

  const topK = 10;
  const codes = await queryCodes(diagnosis, topK);

  res.json({ codes });
});

function sendSecureEmail(subject, body, sender, password, toEmail) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: sender,
      pass: password
    }
  });

  const mailOptions = {
    from: sender,
    to: toEmail,
    subject: subject,
    text: body
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
    } else {
      console.log('Email sent: ' + info.response);
    }
  });
}

app.post('/send_email', (req, res) => {
  const { subject, body, to_email } = req.body;
  console.log(req.body);
  
  try {
    const sender = process.env.MAIL_USERNAME;
    const password = process.env.MAIL_PASSWORD;
    sendSecureEmail(subject, body, sender, password, to_email);
    res.json({ message: 'Email sent successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

app.get("/", (req, res) => {
  const name = process.env.NAME || "World";
  res.send(`Hello ${name} 8787!`);
});

// Export the Express app as a Cloud Function
exports.mainFunction = app;