// Backend ديال الكونفورماسيون عبر WhatsApp Cloud API
// تشغيل: npm i express && node server.js
const express = require("express");
const fs = require("fs");

const {
  WA_TOKEN,            // Access token ديال Meta
  WA_PHONE_ID,         // Phone Number ID ديال الواتساب بزنس
  VERIFY_TOKEN,        // أي كلمة سرية تختارها للويبهوك
  API_KEY,             // كلمة سرية باش غير نتا تزيد الكوموندات
  TEMPLATE = "order_confirmation",
  PORT = 3000,
} = process.env;

const DB = "./orders.json";
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : []);
const save = (o) => fs.writeFileSync(DB, JSON.stringify(o, null, 2));

const app = express();
app.use(express.json());
app.use((req, res, next) => {          // السماح للداشبورد
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html")); // الداشبورد كيتحل فـ /

const toIntl = (p) => "212" + String(p).replace(/\D/g, "").replace(/^0/, "");

async function wa(body) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}

// الميساج الأول: template فيه معلومات الكوموند + 3 أزرار (تأكيد / تعديل / إلغاء)
function sendConfirmation(o) {
  const btn = (i, action) => ({
    type: "button", sub_type: "quick_reply", index: String(i),
    parameters: [{ type: "payload", payload: `${action}:${o.id}` }],
  });
  return wa({
    to: toIntl(o.phone),
    type: "template",
    template: {
      name: TEMPLATE,
      language: { code: "ar" },
      components: [
        {
          type: "body",
          parameters: [o.name, o.product, String(o.qty), String(o.price)].map((t) => ({ type: "text", text: t })),
        },
        btn(0, "confirm"), btn(1, "edit"), btn(2, "cancel"),
      ],
    },
  });
}

// كوموند جديدة (من YouCan webhook ولا من الداشبورد)
app.post("/orders", async (req, res) => {
  if (req.get("x-api-key") !== API_KEY) return res.sendStatus(401);
  const { name, phone, product, price, qty = 1, city = "" } = req.body;
  if (!name || !phone || !product) return res.status(400).json({ error: "name, phone, product required" });
  const orders = load();
  const o = { id: Date.now().toString(36), name, phone, product, price, qty, city, status: "waiting", note: "", at: new Date().toISOString() };
  orders.unshift(o);
  try {
    await sendConfirmation(o);
  } catch (e) {
    o.status = "send_failed"; o.note = String(e.message).slice(0, 300);
  }
  save(orders);
  res.json(o);
});

app.get("/orders", (req, res) => {
  if (req.get("x-api-key") !== API_KEY) return res.sendStatus(401);
  res.json(load());
});

// Meta كتتأكد من الويبهوك
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

// جواب الكليان
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // جاوب Meta بسرعة
  try {
    const msgs = req.body.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const m of msgs) {
      const orders = load();
      const from = m.from;
      const payload = m.button?.payload || m.interactive?.button_reply?.id;

      if (payload) {
        const [action, id] = payload.split(":");
        const o = orders.find((x) => x.id === id);
        if (!o) continue;
        if (action === "confirm") {
          o.status = "confirmed";
          await wa({ to: from, type: "text", text: { body: "شكرا، الكوموند ديالك تأكدات ✅" } });
        } else if (action === "cancel") {
          o.status = "cancelled";
          await wa({ to: from, type: "text", text: { body: "تمّ إلغاء الكوموند. شكرا." } });
        } else if (action === "edit") {
          o.status = "edit_requested";
          await wa({ to: from, type: "text", text: { body: "شنو بغيتي نبدلو ليك؟ كتب لينا هنا (الكمية، العنوان، المنتوج...)." } });
        }
        save(orders);
      } else if (m.type === "text") {
        // نص حر: كيتسجل كملاحظة على آخر كوموند فيها طلب تعديل
        const o = orders.find((x) => x.status === "edit_requested" && toIntl(x.phone) === from);
        if (o) {
          o.note = m.text.body;
          save(orders);
          await wa({ to: from, type: "text", text: { body: "توصلنا بطلب التعديل، غادي نتصلو بيك." } });
        }
      }
    }
  } catch (e) {
    console.error("webhook error", e);
  }
});

app.listen(PORT, () => console.log("Confirmation API on :" + PORT));
