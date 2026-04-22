import { createApp } from './app.js';
import { logger } from './logger.js';

const port = parseInt(process.env.PORT || '5001', 10);

const app = createApp();

app.listen(port, () => {
  logger.info(`API server listening on http://localhost:${port}`);
});
