import 'dotenv/config';
import express from 'express';
import nacl from 'tweetnacl';

const app = express();

const PORT = process.env.PORT || 3000;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const N8N_INTERACTION_WEBHOOK_URL = process.env.N8N_INTERACTION_WEBHOOK_URL;
const N8N_SHARED_SECRET = process.env.N8N_SHARED_SECRET;

if (!DISCORD_PUBLIC_KEY) {
  throw new Error('DISCORD_PUBLIC_KEY manquant dans .env');
}

if (!N8N_INTERACTION_WEBHOOK_URL) {
  throw new Error('N8N_INTERACTION_WEBHOOK_URL manquant dans .env');
}

if (!N8N_SHARED_SECRET) {
  throw new Error('N8N_SHARED_SECRET manquant dans .env');
}

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifyDiscordRequest(req) {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');

  if (!signature || !timestamp || !req.rawBody) {
    return false;
  }

  const message = Buffer.concat([
    Buffer.from(timestamp, 'utf8'),
    req.rawBody,
  ]);

  return nacl.sign.detached.verify(
    message,
    Buffer.from(signature, 'hex'),
    Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
  );
}

async function forwardToN8n(payload) {
  try {
    const response = await fetch(N8N_INTERACTION_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AMC-Bridge-Secret': N8N_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Erreur n8n:', response.status, text);
    }
  } catch (error) {
    console.error('Impossible de transmettre à n8n:', error);
  }
}

function buildActionPayload(interaction) {
  const customId = interaction?.data?.custom_id || '';
  const user = interaction?.member?.user || interaction?.user || {};
  const message = interaction?.message || {};

  let action = 'unknown';
  let batchId = '';

  if (customId.startsWith('amc_validate_')) {
    action = 'validate';
    batchId = customId.replace('amc_validate_', '');
  }

  if (customId.startsWith('amc_refuse_')) {
    action = 'refuse';
    batchId = customId.replace('amc_refuse_', '');
  }

  return {
    source: 'discord',
    action,
    batch_id: batchId,
    custom_id: customId,

    interaction_id: interaction.id,
    interaction_token: interaction.token,
    application_id: interaction.application_id,

    guild_id: interaction.guild_id || '',
    channel_id: interaction.channel_id || '',
    message_id: message.id || '',

    user: {
      id: user.id || '',
      username: user.username || '',
      global_name: user.global_name || '',
    },

    received_at: new Date().toISOString(),
  };
}

app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'AMC Discord Bridge',
  });
});

app.post('/discord/interactions', async (req, res) => {
  const isValid = verifyDiscordRequest(req);

  if (!isValid) {
    return res.status(401).send('Invalid request signature');
  }

  const interaction = req.body;

  // Discord PING
  if (interaction.type === 1) {
    return res.status(200).json({
      type: 1,
    });
  }

  // Message component: bouton, menu, etc.
  if (interaction.type === 3) {
    const payload = buildActionPayload(interaction);

    // Transmission asynchrone à n8n
    forwardToN8n(payload);

    const label =
      payload.action === 'validate'
        ? 'Validation reçue ✅'
        : payload.action === 'refuse'
          ? 'Refus reçu. Je prépare les options de motif.'
          : 'Action reçue.';

    return res.status(200).json({
      type: 4,
      data: {
        content: `${label}\nTraitement en cours dans n8n.`,
        flags: 64
      },
    });
  }

  return res.status(200).json({
    type: 4,
    data: {
      content: 'Interaction reçue.',
      flags: 64
    },
  });
});

app.listen(PORT, () => {
  console.log(`AMC Discord Bridge démarré sur le port ${PORT}`);
});