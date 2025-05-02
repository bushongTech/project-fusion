import express from 'express';
import path from 'path';
import Docker from 'dockerode';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';

const app = express();
const PORT = 8500;
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

// Utility: fetch with timeout
const fetchWithTimeout = async (url, timeoutMs = 2000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch {
        clearTimeout(id);
        return null;
    }
};


// API: Discover microservices with UIs
app.get('/api/microservices', async (req, res) => {
    try {
        const containers = await docker.listContainers();
        const services = [];

        for (const container of containers) {
            const name = container.Names[0].replace(/^\//, '');
            if (name == 'apollo-mission-control') continue;
            if (name == 'lavinmq0') continue;
            if (name == 'lavinmq1') continue;
            if (name == 'lavinmq2') continue;

            const portInfo = container.Ports.find(p => p.Type === 'tcp' && p.PublicPort);
            if (!portInfo) continue;

            const url = `http://${name}:${portInfo.PrivatePort}`;
            console.log(`Trying ${name} at ${url}`);

            const response = await fetchWithTimeout(url);

            if (response && response.ok && response.headers.get('content-type')?.includes('text/html')) {
                if (name == 'lavinmq0-nginx'){
                    const title = 'Overview | LavinMQ 0';
                    services.push({ name, port: portInfo.PublicPort, title });
                } else if(name == 'lavinmq1-nginx'){
                    const title = 'Overview | LavinMQ 1';
                    services.push({ name, port: portInfo.PublicPort, title });
                }else if(name == 'lavinmq2-nginx'){
                    const title = 'Overview | LavinMQ 2';
                    services.push({ name, port: portInfo.PublicPort, title });
                }else{
                    try {
                        const html = await response.text();
                        const dom = new JSDOM(html);
                        const title = dom.window.document.title;
                        services.push({ name, port: portInfo.PublicPort, title });
                    } catch {
                        services.push({ name, port: portInfo.PublicPort, title: name });
                    }
                }
            }
        }

        res.json(services);
    } catch (err) {
        console.error('Error accessing Docker:', err);
        res.status(500).json({ error: 'Failed to list containers' });
    }
});

app.listen(PORT, () => {
    console.log(`Apollo running at http://localhost:${PORT}`);
});