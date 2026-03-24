import fs from 'fs';
import path from 'path';
import { sleep } from '../utils';
import { DUNE_QUERY_ID, X_DUNE_API_KEY } from '../../config';

interface TokenData {
    buy_volume_usd: number;
    latest_price: number;
    net_inflow_usd: number;
    sell_volume_usd: number;
    token_address: string;
    token_symbol: string;
}

// Function to fetch data (mocked for this example)
async function fetchData(): Promise<TokenData[]> {
    const headers = { 'X-DUNE-API-KEY': X_DUNE_API_KEY };
    const execute_res = await fetch(`https://api.dune.com/api/v1/query/${DUNE_QUERY_ID}/execute`, { method: 'POST', headers });
    const execute_json = await execute_res.json();
    const execution_id = execute_json.execution_id;

    const getExecuteStatus = async () => {
        const status_res = await fetch(`https://api.dune.com/api/v1/execution/${execution_id}/status`, { method: 'GET', headers })
        const status_json = await status_res.json();
        return status_json.state;
    }
    while (true){
        await sleep(20 * 1000);
        const execution_state = await getExecuteStatus();
        if(execution_state === "QUERY_STATE_COMPLETED")
            break;
    }

    const result_res = await fetch(`https://api.dune.com/api/v1/execution/${execution_id}/results`, { method: 'GET', headers });
    const result_json = await result_res.json();
    const result = result_json.result.rows;
    return result;
}

// Function to save data to a JSON file
async function saveDataToFile(data: TokenData[], timestamp: string): Promise<void> {
    const filePath = path.join(__dirname, `data_${timestamp}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Function to delete old JSON files
async function deleteOldFiles() {
  const files = await fs.promises.readdir(__dirname);
  const now = Date.now();

  for (const file of files) {
    if (file.startsWith('data_') && file.endsWith('.json')) {
      const stats = await fs.promises.stat(path.join(__dirname, file));
      const fileTime = new Date(stats.mtime).getTime();

      // Delete files older than 24 hours
      if ((now - fileTime) > 24 * 60 * 60 * 1000) {
        await fs.promises.unlink(path.join(__dirname, file));
      }
    }
  }
}


// Function to retrieve data based on the number of latest JSON files
export async function getTrendTokens(limitHours: number = 1, limitElements: number = 100): Promise<TokenData[]> {
    const files = await fs.promises.readdir(__dirname);
    const jsonFiles = files.filter(file => file.startsWith('data_') && file.endsWith('.json'));

    // Determine how many files to retrieve based on limitHours
    const filesToRetrieve = Math.min(limitHours, jsonFiles.length); // Ensure we don't exceed available files
    const latestFiles = jsonFiles.slice(-filesToRetrieve); // Get the latest N files

    const relevantData: TokenData[][] = [];

    for (const file of latestFiles) {
        const data = JSON.parse(await fs.promises.readFile(path.join(__dirname, file), 'utf-8'));
        relevantData.push(data);
    }

    // Find common elements in all fetched data
    const commonElements = relevantData.reduce((acc, curr) => {
        return acc.filter(item => curr.some(el => el.token_address === item.token_address));
    });

    // Return top N elements based on user request
    return commonElements.slice(0, limitElements);
}


// Function to periodically fetch and save data
export async function scheduleTrendDataFetch() {
    console.log("- Updating trend token list...");
    await deleteOldFiles();
    const data = await fetchData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // Format timestamp for filename
    await saveDataToFile(data, timestamp);
    await sleep(60 * 60 * 1000);
    scheduleTrendDataFetch()
    //   }, 60 * 60 * 1000); // Fetch every hour
}

// Start the data fetching schedule
// scheduleTrendDataFetch();

// Example usage: Retrieve data with a limit of 3 hours and top 10 elements
// async function exampleUsage() {
//   const result = await retrieveData(3, 10);
//   console.log(result);
// }

// Uncomment to test the example usage
// exampleUsage();

