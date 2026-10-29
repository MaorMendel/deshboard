// npm run db:seed
import { getDb } from "../src/db";

try {
  process.loadEnvFile(".env");
} catch {
  // אין .env, משתמשים במשתני הסביבה של המערכת
}
import { seed } from "../src/db/seed";

const baseUrl = process.env.APP_URL ?? "http://localhost:3000";

seed(getDb())
  .then(({ customerKey, demoKey }) => {
    console.log("נוצרו קולות, לקוח לדוגמה ודמו לדוגמה.");
    console.log("המפתחות מוצגים רק עכשיו. ב-DB נשמר רק ה-hash שלהם.\n");
    console.log(`לקוח: ${baseUrl}/b/${customerKey}`);
    console.log(`דמו:  ${baseUrl}/b/${demoKey}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
