// netlify/functions/ai-proxy.js
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
    const body = JSON.parse(event.body);
    const { accessToken, model, messages, temperature, max_tokens } = body;

    if (!accessToken) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing access token' }) };
    }

    // 解析用户 ID（从 Supabase JWT 中）
    const userId = parseUserId(accessToken);
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    // 1. 查询用户信息
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=*&user_id=eq.${userId}`, {
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY
      }
    });
    const profiles = await profileRes.json();
    if (!profiles || profiles.length === 0) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Profile not found' }) };
    }
    const profile = profiles[0];

    // 2. 检查权限与额度
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    let canGenerate = false;

    if (profile.is_paid && profile.paid_until && new Date(profile.paid_until) > now) {
      // 付费期内直接放行
      canGenerate = true;
    } else {
      // 免费用户每日额度逻辑
      if (profile.last_login_date !== today) {
        // 今天首次访问，重置额度为 1
        profile.today_credits = 1;
        profile.last_login_date = today;
      }
      if (profile.today_credits > 0) {
        canGenerate = true;
        profile.today_credits = 0; // 扣减
      }
    }

    if (!canGenerate) {
      return { statusCode: 402, body: JSON.stringify({ error: 'No credits. Please upgrade.' }) };
    }

    // 3. 更新用户额度信息
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        today_credits: profile.today_credits,
        last_login_date: profile.last_login_date
      })
    });

    // 4. 调用百炼 API
    const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY;
    const aiResponse = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BAILIAN_API_KEY}`
      },
      body: JSON.stringify({
        model: model || 'qwen-plus',
        messages,
        temperature: temperature || 0.8,
        max_tokens: max_tokens || 2000
      })
    });

    const aiData = await aiResponse.json();
    if (!aiResponse.ok) {
      throw new Error(aiData.error?.message || 'AI API error');
    }

    const outputText = aiData.choices?.[0]?.message?.content || '';

    // 5. 记录使用历史
    await fetch(`${SUPABASE_URL}/rest/v1/generation_history`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        user_id: userId,
        input_text: messages[messages.length - 1].content,
        output_text: outputText,
        created_at: new Date().toISOString()
      })
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
  } catch (e) {
    return null;
  }
}