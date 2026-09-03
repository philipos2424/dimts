/** Local entry point. This is what ngrok fronts. */
import { createApp } from './create-app.js';

const port = Number(process.env.PORT ?? 3000);

createApp().listen(port, () => {
  console.log(`dimts server listening on http://localhost:${port}`);
  console.log(`PUBLIC_BASE_URL = ${process.env.PUBLIC_BASE_URL ?? '(unset)'}`);
});
