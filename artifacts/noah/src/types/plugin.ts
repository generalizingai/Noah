export interface Plugin {
  id: string;
  name: string;
  description: string;
  author: string;
  username?: string;
  image: string;
  category: string;
  installs: number;
  rating_avg: number;
  rating_count: number;
  capabilities: Set<string>;
  created_at: string;
  is_paid?: boolean;
  price?: number;
  payment_plan?: 'monthly_recurring' | 'one_time' | string;
  payment_link?: string;
  is_user_paid?: boolean;
  approved?: boolean;
  private?: boolean;
  enabled?: boolean;
  official?: boolean;
  is_popular?: boolean;
  is_influencer?: boolean;
  source_code_url?: string;
}

export interface PluginStat {
  id: string;
  money: number;
}
