exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config error' }) };
  }

  try {
    const { accessToken, model, messages, temperature, max_tokens } = JSON.parse(event.body);
    if (!accessToken) return { statusCode: 401, body: JSON.stringify({ error: 'Missing token' }) };

    const userId = parseUserId(accessToken);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };

    // 获取用户配置
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!profileRes.ok) return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch profile' }) };
    const profiles = await profileRes.json();
    if (!profiles.length) return { statusCode: 403, body: JSON.stringify({ error: 'Profile not found. Please re-register.' }) };

    const profile = profiles[0];
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    let canGenerate = false;

    if (profile.is_paid && profile.paid_until && new Date(profile.paid_until) > now) {
      canGenerate = true;
    } else {
      if (profile.last_login_date !== today) {
        profile.today_credits = 1;
        profile.last_login_date = today;
      }
      if (profile.today_credits > 0) {
        canGenerate = true;
        profile.today_credits = 0;
      }
    }

    if (!canGenerate) return { statusCode: 402, body: JSON.stringify({ error: 'No credits' }) };

    // 更新额度
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ today_credits: profile.today_credits, last_login_date: profile.last_login_date })
    });

    // 调用 AI
    const aiRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BAILIAN_API_KEY}` },
      body: JSON.stringify({ model: model || 'qwen-plus', messages, temperature: temperature || 0.8, max_tokens: max_tokens || 2000 })
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) throw new Error(aiData.error?.message || 'AI error');

    const outputText = aiData.choices?.[0]?.message?.content || '';

    // 记录历史
    await fetch(`${SUPABASE_URL}/rest/v1/generation_history`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, input_text: messages[messages.length - 1].content, output_text: outputText, created_at: new Date().toISOString() })
    });

    return { statusCode: 200, body: JSON.stringify(aiData) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function parseUserId(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded.sub;
  } catch { return null; }
}