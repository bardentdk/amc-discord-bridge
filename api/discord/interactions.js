import nacl from 'tweetnacl';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function verifyDiscordSignature({ rawBody, signature, timestamp, publicKey }) {
  if (!rawBody || !signature || !timestamp || !publicKey) {
    return false;
  }

  const message = Buffer.from(timestamp + rawBody, 'utf8');

  return nacl.sign.detached.verify(
    message,
    Buffer.from(signature, 'hex'),
    Buffer.from(publicKey, 'hex')
  );
}

function buildActionPayload(interaction) {
  const customId = interaction?.data?.custom_id || '';
  const user = interaction?.member?.user || interaction?.user || {};
  const message = interaction?.message || {};

  let action = 'unknown';
  let scope = 'unknown';
  let batchId = '';
  let postId = '';

  if (customId.startsWith('amc_batch_validate_')) {
    action = 'validate';
    scope = 'batch';
    batchId = customId.replace('amc_batch_validate_', '');
  }

  if (customId.startsWith('amc_batch_refuse_')) {
    action = 'refuse';
    scope = 'batch';
    batchId = customId.replace('amc_batch_refuse_', '');
  }

  if (customId.startsWith('amc_post_validate_')) {
    action = 'validate';
    scope = 'post';
    postId = customId.replace('amc_post_validate_', '');
    batchId = postId.replace(/-\d+$/, '');
  }

  if (customId.startsWith('amc_post_refuse_')) {
    action = 'refuse';
    scope = 'post';
    postId = customId.replace('amc_post_refuse_', '');
    batchId = postId.replace(/-\d+$/, '');
  }

  return {
    source: 'discord',
    action,
    scope,
    batch_id: batchId,
    post_id: postId,
    custom_id: customId,

    interaction_id: interaction.id || '',
    interaction_token: interaction.token || '',
    application_id: interaction.application_id || '',

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

async function forwardToN8n(payload) {
  const webhookUrl = process.env.N8N_INTERACTION_WEBHOOK_URL;
  const sharedSecret = process.env.N8N_SHARED_SECRET;

  if (!webhookUrl || !sharedSecret) {
    console.error('Variables n8n manquantes');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AMC-Bridge-Secret': sharedSecret,
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

export async function POST(request) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  const rawBody = await request.text();

  const isValid = verifyDiscordSignature({
    rawBody,
    signature,
    timestamp,
    publicKey,
  });

  if (!isValid) {
    return new Response('Invalid request signature', {
      status: 401,
    });
  }

  const interaction = JSON.parse(rawBody);

  // Discord PING
  if (interaction.type === 1) {
    return jsonResponse({
      type: 1,
    });
  }

  // Message component : boutons, menus, etc.
  if (interaction.type === 3) {
    const payload = buildActionPayload(interaction);

    const n8nResult = await forwardToN8n(payload);

    const label =
        payload.scope === 'batch' && payload.action === 'validate'
        ? 'Planning complet validé ✅'
        : payload.scope === 'batch' && payload.action === 'refuse'
            ? 'Planning complet refusé ❌'
            : payload.scope === 'post' && payload.action === 'validate'
            ? 'Post validé ✅'
            : payload.scope === 'post' && payload.action === 'refuse'
                ? 'Post refusé ❌'
                : 'Action reçue.';

    const debugLine = n8nResult.ok
        ? 'Transmission vers n8n confirmée.'
        : `Transmission vers n8n non confirmée. Status: ${n8nResult.status}`;

    return jsonResponse({
        type: 4,
        data: {
        content: `${label}\n${debugLine}`,
        flags: 64,
        },
    });
    }

  return jsonResponse({
    type: 4,
    data: {
      content: 'Interaction reçue.',
      flags: 64
    },
  });
}

export async function GET() {
  return jsonResponse({
    ok: true,
    service: 'AMC Discord Bridge',
  });
}