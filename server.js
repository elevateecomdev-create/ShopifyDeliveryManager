require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '24h';
const STORE_DOMAIN = process.env.STORE_DOMAIN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));

const api = axios.create({
    baseURL: `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`,
    headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
    }
});

app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://provitaldeliverymanager-1ed386.netlify.app');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

app.use((req, res, next) => {
    if (req.path === '/login.html' || req.path === '/api/login') {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return authMiddleware(req, res, next);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = users.find(u => u.id === id && u.password === password);
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token, userId: user.id });
});

app.get('/api/orders', async (req, res) => {
    try {
        const cursor = req.query.cursor;
        const cursorParam = cursor ? `, after: "${cursor}"` : '';
        
        const query = `{
      orders(first: 250${cursorParam}, query: "fulfillment_status:fulfilled", sortKey: UPDATED_AT, reverse: true) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            name
            displayFulfillmentStatus
            displayFinancialStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            createdAt
            updatedAt
            lineItems(first: 50) {
              edges {
                node {
                  name
                  quantity
                }
              }
            }
            fulfillments(first: 10) {
              status
              displayStatus
              events(first: 10) {
                edges {
                  node {
                    status
                    happenedAt
                  }
                }
              }
            }
          }
          cursor
        }
      }
    }`;

        const response = await api.post('', { query });
        
        if (response.data.errors) {
            throw new Error(response.data.errors[0].message);
        }
        
        if (!response.data.data?.orders?.edges) {
            throw new Error('Invalid response structure');
        }
        
        const orders = response.data.data.orders.edges
            .map(e => {
                const order = e.node;
                let deliveryStatus = order.displayFulfillmentStatus || 'UNFULFILLED';
                
                if (order.fulfillments && order.fulfillments.length > 0) {
                    const hasDeliveredEvent = order.fulfillments.some(fulfillment => 
                        fulfillment.events && fulfillment.events.edges && 
                        fulfillment.events.edges.some(edge => 
                            edge.node.status === 'DELIVERED'
                        )
                    );
                    if (hasDeliveredEvent) {
                        deliveryStatus = 'DELIVERED';
                    }
                }
                
                return {
                    ...order,
                    orderId: order.id.split('/').pop(),
                    displayFulfillmentStatus: deliveryStatus
                };
            })
            .filter(order => order.displayFulfillmentStatus !== 'DELIVERED');
        
        const pageInfo = response.data.data.orders.pageInfo;
        console.log('Final orders array:', orders);
        res.json({ orders, pageInfo });
    } catch (error) {
        console.error('Orders API error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/order-details', async (req, res) => {
    try {
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;
        
        let dateQuery = '';
        if (startDate && endDate) {
            dateQuery = `created_at:>='${startDate}' AND created_at:<='${endDate}'`;
        } else {
            // Default to last 24 hours (last day till now)
            const past24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            dateQuery = `created_at:>='${past24Hours}'`;
        }
        
        const STORE_DOMAIN = process.env.STORE_DOMAIN;
        const ACCESS_TOKEN = (process.env.NEW_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '').trim();

        if (!STORE_DOMAIN || !ACCESS_TOKEN) {
            throw new Error('Shopify credentials missing in environment variables');
        }

        const detailsApi = axios.create({
            baseURL: `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`,
            headers: {
                'X-Shopify-Access-Token': ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        const query = `{
          orders(first: 250, query: "${dateQuery}", sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                displayFulfillmentStatus
                displayFinancialStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                shippingAddress {
                  name
                  phone
                  address1
                  address2
                  city
                  province
                  zip
                  country
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }`;

        const response = await detailsApi.post('', { query });
        
        if (response.data.errors) {
            throw new Error(response.data.errors[0].message);
        }
        
        if (!response.data.data?.orders?.edges) {
            throw new Error('Invalid response structure');
        }
        
        const orders = response.data.data.orders.edges.map(e => {
            const order = e.node;
            return {
                ...order,
                orderId: order.id.split('/').pop()
            };
        });
        
        res.json({ orders });
    } catch (error) {
        console.error('Order Details API error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/order-details/:orderId/fulfill', authMiddleware, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const STORE_DOMAIN = process.env.STORE_DOMAIN;
        const ACCESS_TOKEN = (process.env.NEW_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '').trim();

        if (!STORE_DOMAIN || !ACCESS_TOKEN) {
            throw new Error('Shopify credentials missing in environment variables');
        }

        const detailsApi = axios.create({
            baseURL: `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`,
            headers: {
                'X-Shopify-Access-Token': ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        const orderQuery = `{
      order(id: "gid://shopify/Order/${orderId}") {
        displayFinancialStatus
        fulfillments(first: 10) {
          id
          status
          displayStatus
        }
        fulfillmentOrders(first: 5) {
          edges {
            node {
              id
              status
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
      }
    }`;

        const orderResponse = await detailsApi.post('', { query: orderQuery });

        if (orderResponse.data.errors) {
            console.error('Shopify order fetch errors:', orderResponse.data.errors);
            return res.status(400).json({ error: orderResponse.data.errors });
        }

        if (!orderResponse.data.data?.order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResponse.data.data.order;

        const existingFulfillments = order.fulfillments;
        const fulfillmentOrders = order.fulfillmentOrders.edges;

        if (existingFulfillments.length > 0) {
            const fulfillmentId = existingFulfillments[0].id;

            const deliveredMutation = `
        mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
          fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
            fulfillmentEvent {
              id
              status
            }
            userErrors { field message }
          }
        }
      `;

            const deliveredVariables = {
                fulfillmentEvent: {
                    fulfillmentId: fulfillmentId,
                    status: "DELIVERED",
                    happenedAt: new Date().toISOString()
                }
            };

            await detailsApi.post('', { query: deliveredMutation, variables: deliveredVariables });
            res.json({ success: true, message: 'Order marked as delivered' });
        } else {
            const openFO = fulfillmentOrders.find(fo => fo.node.status === 'OPEN');
            if (!openFO) {
                return res.status(400).json({ error: 'No open fulfillment orders found' });
            }

            const lineItems = openFO.node.lineItems.edges
                .filter(li => li.node.remainingQuantity > 0)
                .map(li => ({
                    id: li.node.id,
                    quantity: li.node.remainingQuantity
                }));

            const mutation = `
        mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
            fulfillment {
              id
            }
            userErrors { field message }
          }
        }
      `;

            const variables = {
                fulfillment: {
                    lineItemsByFulfillmentOrder: [{
                        fulfillmentOrderId: openFO.node.id,
                        fulfillmentOrderLineItems: lineItems
                    }],
                    trackingInfo: {
                        company: "Manual",
                        number: `DELIVERED-${orderId}`
                    },
                    notifyCustomer: true
                }
            };

            const result = await detailsApi.post('', { query: mutation, variables });

            if (result.data.errors) {
                console.error('Shopify GraphQL errors:', result.data.errors);
                return res.status(400).json({ error: result.data.errors });
            }

            if (!result.data.data?.fulfillmentCreate) {
                console.error('Shopify fulfillmentCreate response null:', result.data);
                return res.status(400).json({ error: 'Fulfillment creation returned null data' });
            }

            if (result.data.data.fulfillmentCreate.userErrors.length > 0) {
                return res.status(400).json({ error: result.data.data.fulfillmentCreate.userErrors });
            }

            const fulfillmentId = result.data.data.fulfillmentCreate.fulfillment.id;

            const deliveredMutation = `
        mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
          fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
            fulfillmentEvent {
              id
              status
            }
            userErrors { field message }
          }
        }
      `;

            const deliveredVariables = {
                fulfillmentEvent: {
                    fulfillmentId: fulfillmentId,
                    status: "DELIVERED",
                    happenedAt: new Date().toISOString()
                }
            };

            await detailsApi.post('', { query: deliveredMutation, variables: deliveredVariables });
            res.json({ success: true, message: 'Order fulfilled and marked as delivered' });
        }
    } catch (error) {
        console.error('Fulfillment error details:', error.response?.data || error.message || error);
        res.status(500).json({ 
            error: error.message,
            details: error.response?.data || null
        });
    }
});

app.post('/api/orders/:orderId/paid', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        
        const mutation = `
            mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
                orderMarkAsPaid(input: $input) {
                    order {
                        id
                        displayFinancialStatus
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;
        
        const variables = {
            input: {
                id: `gid://shopify/Order/${orderId}`
            }
        };
        
        const result = await api.post('', { query: mutation, variables });
        
        if (result.data.data.orderMarkAsPaid.userErrors.length > 0) {
            return res.status(400).json({ error: result.data.data.orderMarkAsPaid.userErrors });
        }
        
        res.json({ success: true, message: 'Order marked as paid' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/orders/:orderId/delivered', async (req, res) => {
    try {
        const orderId = req.params.orderId;

        const orderQuery = `{
      order(id: "gid://shopify/Order/${orderId}") {
        displayFinancialStatus
        fulfillments(first: 10) {
          id
          status
          displayStatus
        }
        fulfillmentOrders(first: 5) {
          edges {
            node {
              id
              status
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
      }
    }`;

        const orderResponse = await api.post('', { query: orderQuery });

        if (!orderResponse.data.data?.order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResponse.data.data.order;
        
        if (order.displayFinancialStatus !== 'PAID') {
            return res.status(400).json({ error: 'Order must be paid before delivery' });
        }

        const existingFulfillments = order.fulfillments;
        const fulfillmentOrders = order.fulfillmentOrders.edges;

        if (existingFulfillments.length > 0) {
            const fulfillmentId = existingFulfillments[0].id;

            const deliveredMutation = `
        mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
          fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
            fulfillmentEvent {
              id
              status
            }
            userErrors { field message }
          }
        }
      `;

            const deliveredVariables = {
                fulfillmentEvent: {
                    fulfillmentId: fulfillmentId,
                    status: "DELIVERED",
                    happenedAt: new Date().toISOString()
                }
            };

            await api.post('', { query: deliveredMutation, variables: deliveredVariables });
            res.json({ success: true, message: 'Order marked as delivered' });
        } else {
            const openFO = fulfillmentOrders.find(fo => fo.node.status === 'OPEN');
            if (!openFO) {
                return res.status(400).json({ error: 'No open fulfillment orders found' });
            }

            const lineItems = openFO.node.lineItems.edges
                .filter(li => li.node.remainingQuantity > 0)
                .map(li => ({
                    fulfillmentOrderLineItemId: li.node.id,
                    quantity: li.node.remainingQuantity
                }));

            const mutation = `
        mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
            fulfillment {
              id
            }
            userErrors { field message }
          }
        }
      `;

            const variables = {
                fulfillment: {
                    lineItemsByFulfillmentOrder: [{
                        fulfillmentOrderId: openFO.node.id,
                        fulfillmentOrderLineItems: lineItems
                    }],
                    trackingInfo: {
                        company: "Manual",
                        number: `DELIVERED-${orderId}`
                    },
                    notifyCustomer: true
                }
            };

            const result = await api.post('', { query: mutation, variables });

            if (result.data.data.fulfillmentCreate.userErrors.length > 0) {
                return res.status(400).json({ error: result.data.data.fulfillmentCreate.userErrors });
            }

            const fulfillmentId = result.data.data.fulfillmentCreate.fulfillment.id;

            const deliveredMutation = `
        mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
          fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
            fulfillmentEvent {
              id
              status
            }
            userErrors { field message }
          }
        }
      `;

            const deliveredVariables = {
                fulfillmentEvent: {
                    fulfillmentId: fulfillmentId,
                    status: "DELIVERED",
                    happenedAt: new Date().toISOString()
                }
            };

            await api.post('', { query: deliveredMutation, variables: deliveredVariables });
            res.json({ success: true, message: 'Order fulfilled and marked as delivered' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
