import os
import time
from datetime import datetime
from pymongo import MongoClient
from flask import Flask, jsonify
import threading

app = Flask(__name__)

# DB connection
DB_HOST = os.getenv('DBHOST', 'localhost')
client = MongoClient(f'mongodb://{DB_HOST}:27017/')
db = client['cloneDetector']

# Collections
collections = ['files', 'chunks', 'candidates', 'clones']
status_collection = db['statusUpdates']

# Store samples for stats
samples = []

def get_counts():
    counts = {}
    for coll in collections:
        try:
            counts[coll] = db[coll].count_documents({})
        except Exception as e:
            counts[coll] = 0  # Collection doesn't exist yet
    return counts

def get_latest_status():
    updates = list(status_collection.find().sort('timestamp', -1).limit(5))
    for update in updates:
        update['_id'] = str(update['_id'])  # Convert ObjectId to string
    return updates

def calculate_stats():
    if len(samples) < 2:
        return {}
    # Simple: time per chunk, etc.
    latest = samples[-1]
    prev = samples[-2]
    time_diff = (latest['time'] - prev['time']).total_seconds()
    chunk_diff = latest['counts']['chunks'] - prev['counts']['chunks']
    rate = chunk_diff / time_diff if time_diff > 0 else 0
    return {'chunk_rate_per_sec': rate}

@app.route('/')
def dashboard():
    counts = get_counts()
    status = get_latest_status()
    stats = calculate_stats()
    response = {
        'counts': counts,
        'status_updates': status,
        'stats': stats,
        'timestamp': datetime.now().isoformat()
    }
    # Convert ObjectId to string
    import json
    from bson import ObjectId
    return app.response_class(
        response=json.dumps(response, default=str),
        mimetype='application/json'
    )

def monitor_loop():
    while True:
        counts = get_counts()
        samples.append({
            'time': datetime.now(),
            'counts': counts
        })
        # Keep last 100 samples
        if len(samples) > 100:
            samples.pop(0)
        print(f"Counts: {counts}")
        time.sleep(10)  # Sample every 10 seconds

if __name__ == '__main__':
    # Start monitoring thread
    threading.Thread(target=monitor_loop, daemon=True).start()
    # Run Flask app
    app.run(host='0.0.0.0', port=5000)