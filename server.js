// Backend ديال الكونفورماسيون عبر WhatsApp Cloud API
// تشغيل: npm i express && node server.js
const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

const {
  WA_TOKEN,            // Access token ديال Meta
  WA_PHONE_ID,         // Phone Number ID ديال الواتساب بزنس
  VERIFY_TOKEN,        // أي كلمة سرية تختارها للويبهوك
  API_KEY,             // كلمة سرية باش غير نتا تزيد الكوموندات
  TEMPLATE = "order_confirmation",
  YOUCAN_CLIENT_ID,    // من Partner Dashboard ديال YouCan
  YOUCAN_CLIENT_SECRET,
  PUBLIC_URL,          // عنوان السيرفر بلا / فالأخير
  PORT = 3000,
} = process.env;

const DB = process.env.DB_PATH || "./orders.json";
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : []);
const save = (o) => fs.writeFileSync(DB, JSON.stringify(o, null, 2));

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {          // السماح للداشبورد
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html")); // الداشبورد كيتحل فـ /

const toIntl = (p) => {
  const d = String(p).replace(/\D/g, "");
  if (d.startsWith("212")) return d;
  return "212" + d.replace(/^0/, "");
};

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

// تخلق كوموند وتصيفط ميساج الكونفورماسيون
async function createOrder({ name, phone, product, price = 0, qty = 1, city = "", source = "manual", ref = "" }) {
  const orders = load();
  const o = { id: Date.now().toString(36), name, phone, product, price, qty, city, status: "waiting", note: "", source, ref, at: new Date().toISOString() };
  orders.unshift(o);
  save(orders);
  try {
    await sendConfirmation(o);
  } catch (e) {
    o.status = "send_failed"; o.note = String(e.message).slice(0, 300);
    save(orders);
  }
  return o;
}

// كوموند جديدة من الداشبورد
app.post("/orders", async (req, res) => {
  if (req.get("x-api-key") !== API_KEY) return res.sendStatus(401);
  const { name, phone, product } = req.body;
  if (!name || !phone || !product) return res.status(400).json({ error: "name, phone, product required" });
  res.json(await createOrder(req.body));
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

// ================= YouCan =================
const TOK = DB.replace(/orders\.json$/, "youcan.json");
const LAST = DB.replace(/orders\.json$/, "youcan-last.json");
const ycRead = () => (fs.existsSync(TOK) ? JSON.parse(fs.readFileSync(TOK)) : {});
const ycWrite = (d) => fs.writeFileSync(TOK, JSON.stringify(d, null, 2));
const CB = () => `${PUBLIC_URL}/youcan/callback`;
const form = (o) => new URLSearchParams(o);

// 1) الدخول: حل /youcan/install?key=API_KEY مرة وحدة
app.get("/youcan/install", (req, res) => {
  if (req.query.key !== API_KEY) return res.sendStatus(401);
  const q = form({ client_id: YOUCAN_CLIENT_ID, redirect_uri: CB(), response_type: "code" });
  q.append("scope[]", "read-orders");
  q.append("scope[]", "edit-rest-hooks");
  res.redirect("https://seller-area.youcan.shop/admin/oauth/authorize?" + q);
});

// 2) YouCan كيرجع هنا: كنبدلو الكود بتوكن وكنشتركو فـ order.created
app.get("/youcan/callback", async (req, res) => {
  try {
    if (req.query.error) return res.send("تلغات العملية.");
    const r = await fetch("https://api.youcan.shop/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form({ grant_type: "authorization_code", client_id: YOUCAN_CLIENT_ID, client_secret: YOUCAN_CLIENT_SECRET, redirect_uri: CB(), code: req.query.code }),
    });
    const t = await r.json();
    if (!t.access_token) throw new Error(JSON.stringify(t));
    ycWrite({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 0) * 1000 });
    const s = await fetch("https://api.youcan.shop/resthooks/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ event: "order.created", target_url: `${PUBLIC_URL}/youcan/webhook` }),
    });
    const sj = await s.json();
    if (!s.ok) throw new Error(JSON.stringify(sj));
    res.send("تربط YouCan بنجاح ✅ دابا كل كوموند جديدة غادي توصل للداشبورد بوحدها.");
  } catch (e) {
    res.status(500).send("وقع مشكل: " + String(e.message).slice(0, 400));
  }
});

async function ycToken() {
  const t = ycRead();
  if (!t.access_token) return null;
  if (t.expires_at && Date.now() > t.expires_at - 3600e3 && t.refresh_token) {
    const r = await fetch("https://api.youcan.shop/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form({ grant_type: "refresh_token", client_id: YOUCAN_CLIENT_ID, client_secret: YOUCAN_CLIENT_SECRET, refresh_token: t.refresh_token }),
    });
    const n = await r.json();
    if (n.access_token) {
      ycWrite({ access_token: n.access_token, refresh_token: n.refresh_token || t.refresh_token, expires_at: Date.now() + (n.expires_in || 0) * 1000 });
      return n.access_token;
    }
  }
  return t.access_token;
}

async function ycFetchOrder(id) {
  try {
    const tk = await ycToken();
    if (!tk) return null;
    const r = await fetch(`https://api.youcan.shop/orders/${id}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.data || j;
  } catch { return null; }
}

// استخراج المعلومات (كنجربو أكثر من مكان حيت الشكل ممكن يختلف)
const pick = (...v) => v.find((x) => x !== undefined && x !== null && String(x).trim() !== "");
const phoneOf = (o) => pick(o.customer?.phone, o.customer?.mobile, o.shipping?.address?.phone, o.shipping_address?.phone, o.billing_address?.phone, o.address?.phone, o.phone);
const nameOf = (o) => pick(
  o.customer?.full_name, o.customer?.name,
  [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" "),
  [o.shipping?.address?.first_name, o.shipping?.address?.last_name].filter(Boolean).join(" "),
  o.name,
) || "";
const cityOf = (o) => pick(o.shipping?.address?.city, o.shipping_address?.city, o.customer?.city, o.address?.city, o.city) || "";
const itemsOf = (o) => o.variants || o.items || o.products || o.order_items || o.order_variants || [];
const itemName = (i) => pick(i.product?.name, i.name, i.product_name, i.variant?.product?.name, i.title) || "المنتوج";

app.post("/youcan/webhook", async (req, res) => {
  const sig = req.get("x-youcan-signature") || "";
  const exp = crypto.createHmac("sha256", YOUCAN_CLIENT_SECRET || "").update(req.rawBody || "").digest("hex");
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.sendStatus(401);
  res.sendStatus(200); // نجاوبو بسرعة، والخدمة من بعد
  try {
    fs.writeFileSync(LAST, JSON.stringify({ topic: req.get("x-youcan-topic"), body: req.body }, null, 2));
    if ((req.get("x-youcan-topic") || req.body.event_name) !== "order.created") return;
    let d = req.body.data || {};
    const ref = String(d.ref || d.id || "");
    if (load().some((x) => x.source === "youcan" && x.ref === ref)) return; // كوموند ديجا موجودة
    if (!phoneOf(d) || !itemsOf(d).length) d = (await ycFetchOrder(d.id)) || d;
    const items = itemsOf(d);
    const product = items.length ? items.map(itemName).join("، ") : "المنتوج";
    const qty = items.length ? items.reduce((n, i) => n + (Number(i.quantity) || 1), 0) : 1;
    const phone = phoneOf(d);
    const base = { name: nameOf(d) || "الكليان", phone, product, price: d.total || 0, qty, city: cityOf(d), source: "youcan", ref };
    if (phone) return void (await createOrder(base));
    const orders = load();
    orders.unshift({ id: Date.now().toString(36), ...base, phone: "", status: "send_failed", note: "ما لقيناش رقم التيليفون فكوموند YouCan", at: new Date().toISOString() });
    save(orders);
  } catch (e) {
    console.error("youcan webhook error", e);
  }
});

// باش نشوفو آخر payload وصل من YouCan (إلا خاصنا نعدلو الاستخراج)
app.get("/debug/youcan-last", (req, res) => {
  if (req.get("x-api-key") !== API_KEY && req.query.key !== API_KEY) return res.sendStatus(401);
  res.type("json").send(fs.existsSync(LAST) ? fs.readFileSync(LAST) : "{}");
});


app.listen(PORT, () => console.log("Confirmation API on :" + PORT));
