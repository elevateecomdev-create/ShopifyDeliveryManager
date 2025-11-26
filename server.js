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

const users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));

const api = axios.create({
    baseURL: `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`,
    headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
    }
});

app.use(express.json());

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

app.use(express.static('public'));

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
    res.redirect('/login.html');
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});