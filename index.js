const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const admin = require("firebase-admin");
const serviceAccount = require("./zapShift-firebase-admin-secret-key.json");
const app = express()
const port = process.env.PORT;


admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
    const fbToken = req.headers.authorization;
    // console.log("FB Token:", fbToken);
    if (!fbToken) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }

    try {
        const idToken = fbToken.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        // console.log("Decoded Token:", decodedToken);
        req.decoded_email = decodedToken.email;
        next();
    }
    catch (error) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }


}

const uri = process.env.URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});



function generateTrackingId(prefix = "PAR") {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();

    return `${prefix}-${date}-${random}`;
}


async function run() {
    try {
        await client.connect();
        const db = client.db('zap_shift_data');
        const userCollections = db.collection('users');
        const parcelCollections = db.collection('parcels');
        const paymentCollections = db.collection('payments');
        const riderCollections = db.collection('riders');

        // Parcel related API
        app.get('/parcels', async (req, res) => {
            const query = {};
            const { email } = req.query;
            if (email) {
                query.senderEmail = email;
            }
            const options = { sort: { createdAt: -1 } }
            const parcels = await parcelCollections.find(query, options).toArray();
            res.send(parcels);

        })

        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const cursor = { _id: new ObjectId(id) };
            const result = await parcelCollections.findOne(cursor);
            res.send(result);
        })

        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            parcel.createdAt = new Date();
            const result = await parcelCollections.insertOne(parcel);
            res.send(result);
        });
        app.delete('/parcels/:id', async (req, res) => {
            const parcelId = req.params.id;
            const cursor = { _id: new ObjectId(parcelId) };
            const result = await parcelCollections.deleteOne(cursor);
            res.send(result);
        });

        app.patch('/parcels/:id', async (req, res) => {
            const parcelId = req.params.id;
            const updateData = req.body;
            const query = { _id: new ObjectId(parcelId) };
            const update = {
                $set: updateData
            };
            const result = await parcelCollections.updateOne(query, update);
            res.send(result);
        })

        // payment related api
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        price_data: {
                            currency: "usd",
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });
            // console.log(session);
            res.send({ url: session.url });

            // res.redirect(303, session.url);
        });

        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            // console.log(sessionId);
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            // console.log(session);

            const transactionId = session.payment_intent;
            const queryExistingPayment = { transactionId: transactionId };
            const existingPayment = await paymentCollections.findOne(queryExistingPayment);
            if (existingPayment) {
                return res.send({
                    success: true,
                    message: 'Payment already processed',
                    trackingId: existingPayment.trackingId,
                    transactionId: transactionId
                });
            }

            const trackingId = generateTrackingId();
            if (session.payment_status === 'paid') {
                const parcelId = session.metadata.parcelId;
                const query = { _id: new ObjectId(parcelId) };
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        trackingId: trackingId,
                    }
                }
                const result = await parcelCollections.updateOne(query, update);


                const payment = {
                    amount: session.amount_total / 100,
                    transactionId: transactionId,
                    currency: session.currency,
                    paymentStatus: session.payment_status,
                    senderEmail: session.customer_email,
                    parcelId: parcelId,
                    parcelName: session.metadata.parcelName,
                    paidAt: new Date(),
                    paymentStatus: session.payment_status,
                    trackingId: trackingId
                }

                if (session.payment_status === 'paid') {
                    const paymentResult = await paymentCollections.insertOne(payment);
                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: paymentResult
                    });
                }

            }
            res.send({ success: false });
        });

        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            // console.log(email, req.headers.authorization);
            if (email) {
                query.senderEmail = email;

                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'Forbidden access' });
                }
            }
            const options = { sort: { paidAt: -1 } }
            const payments = await paymentCollections.find(query, options).toArray();
            res.send(payments);
        });

        // User related API
        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'user';
            user.createdAt = new Date();
            const query = { email: user.email };
            const existingUser = await userCollections.findOne(query);
            if (existingUser) {
                return res.send({ message: 'User already exists' });
            }
            const result = await userCollections.insertOne(user);
            res.send(result);
        });

        // Rider related API

        app.get('/riders', async (req, res) => {
            const { status } = req.query;
            const query = status ? { status } : {};
            const riders = await riderCollections.find(query).toArray();
            res.send(riders);
        });
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending';
            rider.createdAt = new Date();
            const result = await riderCollections.insertOne(rider);
            res.send(result);
        });

        app.patch('/riders/:id', async (req, res) => {
            const riderId = req.params.id;
            const status = req.body.status;
            const query = { _id: new ObjectId(riderId) };
            const update = {
                $set: { status: status }
            };
            const result = await riderCollections.updateOne(query, update);
            if(status === 'approved'){
                const email = req.body.email;
                const queryUser = { email: email };
                const updateUser ={
                    $set: { role: 'rider' }
                }
                await userCollections.updateOne(queryUser, updateUser);
            }
            res.send(result);
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    }
    finally {
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Zap Shift Backend is Running')
})

app.listen(port, () => {
    console.log(`Zap Shift app listening on port ${port}`)
})
