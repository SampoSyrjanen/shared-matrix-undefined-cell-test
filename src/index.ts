import cluster from "node:cluster";
import process from "node:process";
import fs from "node:fs";
import { AzureClient, AzureClientProps } from "@fluidframework/azure-client";
import { InsecureTokenProvider } from "@fluidframework/test-client-utils";
import { SharedMatrix } from "@fluidframework/matrix";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const containerSchema = {
    initialObjects: { matrix: SharedMatrix }
};

type MatrixTestConfig = {
    numWorkers: number,
    numOperationsPerWorker: number,
};

type MatrixTestWorkerConfig = MatrixTestConfig & {
    containerId: string,
}

async function createFluidClient(config: MatrixTestConfig) {
    let clientProps: AzureClientProps = {
        connection: {
            type: "local",
            endpoint: "http://localhost:7070",
            // @ts-ignore
            tokenProvider: new InsecureTokenProvider("", { id: "1234", name: "Test User" }),
        }
    };
    const fluidClient = new AzureClient(clientProps);
    return fluidClient;
}

export async function matrixTest(config: MatrixTestConfig) {
    const fluidClient = await createFluidClient(config);
    const { container, services } = await fluidClient.createContainer(containerSchema);
    const containerId = await container.attach();
    const matrix = container.initialObjects?.matrix as SharedMatrix;
    matrix.insertRows(0, 1);

    const workerExitPromiseList: Promise<number>[] = [];
    for (let i = 0; i < config.numWorkers; ++i) {
        const worker = cluster.fork();
        workerExitPromiseList.push(new Promise<number>(resolve => worker.once("exit", code => resolve(code))));
        const workerConfig = {
            ...config,
            containerId: containerId,
        };
        worker.send(workerConfig);
    }
    const settledResult = await Promise.allSettled(workerExitPromiseList);
    console.log("All workers done.");
    container.dispose();

    const gotUndefinedCell = settledResult.some(result => result.status === "fulfilled" && result.value !== 0);
    return gotUndefinedCell;
}

export async function matrixTestWorker(config: MatrixTestWorkerConfig) {
    let gotUndefinedCell = false;
    const fluidClient = await createFluidClient(config);
    const { container, services } = await fluidClient.getContainer(config.containerId, containerSchema);
    const matrix = container.initialObjects?.matrix as SharedMatrix;

    const matrixRowReadyPromise = new Promise<void>(resolve => {
        const checkResolved = () => {
            if (matrix.rowCount === 1) {
                matrix.closeMatrix(matrixConsumer);
                resolve();
            }
        };
        const matrixConsumer = {
            rowsChanged: () => { checkResolved(); },
            colsChanged: () => {},
            cellsChanged: () => {},
        };
        matrix.openMatrix(matrixConsumer);
        checkResolved();
    });

    const matrixTestSequenceEndPromise = new Promise<void>(resolve => {
        const checkResolved = () => {
            if (matrix.colCount === config.numWorkers*config.numOperationsPerWorker) {
                matrix.closeMatrix(matrixConsumer);
                resolve();
            }
        };
        const matrixConsumer = {
            rowsChanged: () => {},
            colsChanged: () => { checkResolved(); },
            cellsChanged: () => {},
        };
        matrix.openMatrix(matrixConsumer);
        checkResolved();
    });

    await matrixRowReadyPromise;

    const checkSequence = () => {
        for (let i = 0; i < matrix.colCount; ++i) {
            const value = matrix.getCell(0, i);
            if (value === undefined) {
                gotUndefinedCell = true;
                console.log(`[worker ${process.pid}] 😿 undefined cell, column ${i}, colCount ${matrix.colCount}`);
            }
        }
    };

    for (let i = 0; i < config.numOperationsPerWorker; ++i) {
        checkSequence();
        const colCount = matrix.colCount;
        matrix.insertCols(colCount, 1);
        matrix.setCell(0, colCount, i);
        sleep(1);
    }

    await matrixTestSequenceEndPromise;
    container.disconnect();

    return gotUndefinedCell;
}

async function run() {
    if (cluster.isPrimary) {
        const testConfig = JSON.parse(fs.readFileSync("./test_config.json", "utf8")) as MatrixTestConfig;
        console.log(`Test config ${JSON.stringify(testConfig)}`);
        while (true) {
            const gotUndefinedCell = await matrixTest(testConfig);
            if (!gotUndefinedCell) {
                console.log("Test did not encounter undefined cells. Repeating test.");
            } else {
                break;
            }
        }
    } else {
        // This is a worker process.
        // Wait for config.
        const workerConfig = await new Promise(resolve => process.once("message", resolve)) as MatrixTestWorkerConfig;
        const gotUndefinedCell = await matrixTestWorker(workerConfig);
        if (gotUndefinedCell) {
            process.exit(1);
        }
        process.disconnect();
    }
}

run().catch(console.log);