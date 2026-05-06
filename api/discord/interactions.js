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
  const sharedSecret = process.env.N8N_SHARED_SECRET || '';

  if (!webhookUrl) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: 'N8N_INTERACTION_WEBHOOK_URL manquant',
    };
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

    let body = '';

    try {
      body = await response.text();
    } catch (error) {
      body = '';
    }

    console.log('Transmission n8n:', {
      ok: response.ok,
      status: response.status,
      body,
    });

    return {
      ok: response.ok,
      status: response.status,
      body,
      error: '',
    };
  } catch (error) {
    console.error('Erreur transmission n8n:', error);

    return {
      ok: false,
      status: 0,
      body: '',
      error: error?.message || 'Erreur inconnue',
    };
  }
}

function getInteractionLabel(payload) {
  if (payload.scope === 'batch' && payload.action === 'validate') {
    return 'Planning complet validé ✅';
  }

  if (payload.scope === 'batch' && payload.action === 'refuse') {
    return 'Planning complet refusé ❌';
  }

  if (payload.scope === 'post' && payload.action === 'validate') {
    return 'Post validé ✅';
  }

  if (payload.scope === 'post' && payload.action === 'refuse') {
    return 'Post refusé ❌';
  }

  return 'Action reçue.';
}

function buildDiscordCallbackResponse(payload, n8nResult) {
  const label = getInteractionLabel(payload);

  const debugLine = n8nResult?.ok
    ? 'Transmission vers n8n confirmée.'
    : `Transmission vers n8n non confirmée. Status: ${n8nResult?.status || 0}`;

  return {
    type: 4,
    data: {
      content: `${label}\n${debugLine}`,
      flags: 64,
    },
  };
}

export async function POST(request) {
  try {
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
      console.error('Signature Discord invalide');

      return new Response('Invalid request signature', {
        status: 401,
      });
    }

    let interaction;

    try {
      interaction = JSON.parse(rawBody);
    } catch (error) {
      console.error('JSON Discord invalide:', error);

      return jsonResponse({
        type: 4,
        data: {
          content: 'Payload Discord invalide.',
          flags: 64,
        },
      });
    }

    // Discord PING
    if (interaction.type === 1) {
      return jsonResponse({
        type: 1,
      });
    }

    // Boutons / menus Discord
    if (interaction.type === 3) {
      const payload = buildActionPayload(interaction);

      console.log('Interaction Discord reçue:', payload);

      const n8nResult = await forwardToN8n(payload);

      return jsonResponse(
        buildDiscordCallbackResponse(payload, n8nResult),
        200
      );
    }

    return jsonResponse({
      type: 4,
      data: {
        content: 'Interaction reçue, mais non prise en charge.',
        flags: 64,
      },
    });
  } catch (error) {
    console.error('Erreur globale Discord bridge:', error);

    // Important : on retourne quand même une réponse Discord valide
    return jsonResponse({
      type: 4,
      data: {
        content: `Erreur interne du bridge Discord.\n${error?.message || 'Erreur inconnue'}`,
        flags: 64,
      },
    });
  }
}

export async function GET() {
  return jsonResponse({
    ok: true,
    service: 'AMC Discord Bridge',
    n8n_webhook_configured: Boolean(process.env.N8N_INTERACTION_WEBHOOK_URL),
    n8n_webhook_preview: process.env.N8N_INTERACTION_WEBHOOK_URL
      ? process.env.N8N_INTERACTION_WEBHOOK_URL.replace(/\/webhook\/.*/, '/webhook/***')
      : null,
    deployed_at: new Date().toISOString(),
  });
}