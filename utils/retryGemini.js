async function withGeminiRetry(operation, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const onRetry = options.onRetry || (() => {});

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const status = error.status || error.statusCode;
      const transient = status === 429 || status === 503;
      if (!transient || attempt === maxAttempts) throw error;
      onRetry({ error, attempt, nextAttempt: attempt + 1 });
      await sleep(2000 * attempt);
    }
  }
  throw new Error('Gemini API retry limit reached.');
}

module.exports = { withGeminiRetry };
