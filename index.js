const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const app = express()
const port = process.env.PORT;


app.use(cors());
app.use(express.json());

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
        const parcelCollections = db.collection('parcels');
        const paymentCollections = db.collection('payments');

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
                    transactionId: session.payment_intent,
                    currency: session.currency,
                    paymentStatus: session.payment_status,
                    senderEmail: session.customer_email,
                    parcelId: parcelId,
                    parcelName: session.metadata.parcelName,
                    paidAt: new Date(),
                    paymentStatus: session.payment_status,
                }

                if (session.payment_status === 'paid') {
                    const paymentResult = await paymentCollections.insertOne(payment);
                    res.send({ success: true, 
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                         paymentInfo: paymentResult });
                }

            }
            res.send({ success: false });
        })
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
