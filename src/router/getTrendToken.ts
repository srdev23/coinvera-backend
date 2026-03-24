import { getTrendTokens } from "../service/trendTokenList/fetchTrendTokens";

export async function handleTrendTokenRequest(req: any, res: any){
  try {
    const hour = req.query.hour as number;
    const limit = req.query.limit as number;
    const tokens = await getTrendTokens(hour, limit);
    res.status(200).json(tokens);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
}