const express = require("express");
const axios = require("axios");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
const cors = require("cors");

app.use(cors({
  origin: "https://xeno-frontend-seven.vercel.app",
  credentials: true,
}));

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// Root route
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// -------------------------
// Auth Routes
// -------------------------
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed },
    });
    res.json({ message: "User created", userId: user.id });
  } catch (err) {
    res.status(400).json({ error: "User already exists" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token });
});

// Get current user info
app.get("/me", auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, createdAt: true }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token provided" });

  try {
    const token = header.split(" ")[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// -------------------------
// Tenant Routes
// -------------------------
app.post("/tenants", auth, async (req, res) => {
  const { name, storeUrl, apiToken } = req.body;

  try {
    const tenant = await prisma.store.create({
      data: {
        name,
        storeUrl,
        apiToken,
        userId: req.userId,
      },
    });
    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: "Failed to create tenant" });
  }
});

app.get("/tenants", auth, async (req, res) => {
  const tenants = await prisma.store.findMany({
    where: { userId: req.userId },
  });
  res.json(tenants);
});

// Add stores endpoint for frontend compatibility
app.get("/stores", auth, async (req, res) => {
  const stores = await prisma.store.findMany({
    where: { userId: req.userId },
  });
  res.json(stores);
});

// -------------------------
// Sync Endpoint
// -------------------------
app.get("/sync/:tenantId", auth, async (req, res) => {
  const { tenantId } = req.params;

  try {
    const tenant = await prisma.store.findFirst({
      where: { id: parseInt(tenantId), userId: req.userId },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    // 1️⃣ Fetch Customers
    const customersRes = await axios.get(
      `${tenant.storeUrl}/admin/api/2025-01/customers.json`,
      { headers: { "X-Shopify-Access-Token": tenant.apiToken } }
    );

    for (const c of customersRes.data.customers) {
      await prisma.customer.upsert({
        where: { shopifyId: c.id.toString() },
        update: { name: c.first_name, email: c.email },
        create: {
          shopifyId: c.id.toString(),
          name: c.first_name || "Unknown",
          email: c.email || "dummy@gmail.com",
          storeId: tenant.id,
        },
      });
    }

    // 2️⃣ Fetch Products
    const productsRes = await axios.get(
      `${tenant.storeUrl}/admin/api/2025-01/products.json`,
      { headers: { "X-Shopify-Access-Token": tenant.apiToken } }
    );

    for (const p of productsRes.data.products) {
      await prisma.product.upsert({
        where: { shopifyId: p.id.toString() },
        update: { title: p.title, price: parseFloat(p.variants?.[0]?.price || 0) },
        create: {
          shopifyId: p.id.toString(),
          title: p.title,
          price: parseFloat(p.variants?.[0]?.price || 0),
          storeId: tenant.id,
        },
      });
    }

    // 3️⃣ Fetch Orders
    const ordersRes = await axios.get(
      `${tenant.storeUrl}/admin/api/2025-01/orders.json?status=any`,
      { headers: { "X-Shopify-Access-Token": tenant.apiToken } }
    );

    for (const o of ordersRes.data.orders) {
      let customerId = null;

      if (o.customer && o.customer.id) {
        const customer = await prisma.customer.findUnique({
          where: { shopifyId: o.customer.id.toString() },
        });
        if (customer) customerId = customer.id;
      } else {
        const guestCustomer = await prisma.customer.upsert({
          where: { shopifyId: `guest-${o.id}` },
          update: {},
          create: {
            shopifyId: `guest-${o.id}`,
            name: "Guest",
            email: "guest@example.com",
            storeId: tenant.id,
          },
        });
        customerId = guestCustomer.id;
      }

      await prisma.order.upsert({
        where: { shopifyId: o.id.toString() },
        update: {
          total: parseFloat(o.total_price),
          createdAt: new Date(o.created_at),
          customerId,
        },
        create: {
          shopifyId: o.id.toString(),
          total: parseFloat(o.total_price),
          createdAt: new Date(o.created_at),
          storeId: tenant.id,
          customerId,
        },
      });
    }

    // 4️⃣ Return Stats
    const totalCustomers = await prisma.customer.count({ where: { storeId: tenant.id } });
    const totalOrders = await prisma.order.count({ where: { storeId: tenant.id } });
    const totalRevenueData = await prisma.order.aggregate({
      _sum: { total: true },
      where: { storeId: tenant.id },
    });
    const totalRevenue = totalRevenueData._sum.total || 0;

    const customers = await prisma.customer.findMany({
      where: { storeId: tenant.id },
      include: { orders: true },
    });
    const topCustomers = customers
      .map(c => ({ name: c.name, spend: c.orders.reduce((sum, o) => sum + o.total, 0) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);

    res.json({
      message: "Data synced successfully!",
      totalCustomers,
      totalOrders,
      totalRevenue,
      topCustomers,
    });
  } catch (err) {
    console.error("SYNC ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Sync failed" });
  }
});

// -------------------------
// Stats Endpoint
// -------------------------
app.get("/stats/:tenantId", auth, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const totalCustomers = await prisma.customer.count({ where: { storeId: parseInt(tenantId) } });
    const totalOrders = await prisma.order.count({ where: { storeId: parseInt(tenantId) } });
    const totalRevenueData = await prisma.order.aggregate({
      _sum: { total: true },
      where: { storeId: parseInt(tenantId) },
    });
    const totalRevenue = totalRevenueData._sum.total || 0;

    const customers = await prisma.customer.findMany({
      where: { storeId: parseInt(tenantId) },
      include: { orders: true },
    });

    const topCustomers = customers
      .map(c => ({ name: c.name, spend: c.orders.reduce((sum, o) => sum + o.total, 0) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);

    res.json({ totalCustomers, totalOrders, totalRevenue, topCustomers });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Get daily revenue data for date range
app.get("/stats/:tenantId/revenue", auth, async (req, res) => {
  const { tenantId } = req.params;
  const { startDate, endDate } = req.query;
  
  try {
    const orders = await prisma.order.findMany({
      where: {
        storeId: parseInt(tenantId),
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate + 'T23:59:59.999Z')
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Group orders by date
    const dailyRevenue = {};
    orders.forEach(order => {
      const date = order.createdAt.toISOString().split('T')[0];
      if (!dailyRevenue[date]) {
        dailyRevenue[date] = 0;
      }
      dailyRevenue[date] += order.total;
    });

    // Generate all dates in range
    const dates = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      dates.push(dateStr);
    }

    const data = dates.map(date => dailyRevenue[date] || 0);
    
    res.json({ labels: dates, data });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch revenue data" });
  }
});

// Get daily orders data for date range
app.get("/stats/:tenantId/orders", auth, async (req, res) => {
  const { tenantId } = req.params;
  const { startDate, endDate } = req.query;
  
  try {
    const orders = await prisma.order.findMany({
      where: {
        storeId: parseInt(tenantId),
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate + 'T23:59:59.999Z')
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Group orders by date
    const dailyOrders = {};
    orders.forEach(order => {
      const date = order.createdAt.toISOString().split('T')[0];
      if (!dailyOrders[date]) {
        dailyOrders[date] = 0;
      }
      dailyOrders[date] += 1;
    });

    // Generate all dates in range
    const dates = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      dates.push(dateStr);
    }

    const data = dates.map(date => dailyOrders[date] || 0);
    
    res.json({ labels: dates, data });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders data" });
  }
});

// Start server
app.listen(3000, () => console.log("Server running on http://localhost:3000"));
