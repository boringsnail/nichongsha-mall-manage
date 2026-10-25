import { api } from './http';

export interface Category {
  id: number;
  name: string;
  icon?: string;
  sortOrder: number;
  createdAt?: string;
}

export interface CategoryInput {
  name: string;
  icon?: string;
  sortOrder?: number;
}

export function listCategories(): Promise<Category[]> {
  return api.get<Category[]>('/admin/categories');
}

export function createCategory(data: CategoryInput): Promise<Category> {
  return api.post<Category>('/admin/categories', data);
}

export function updateCategory(id: number, data: Partial<CategoryInput>): Promise<Category> {
  return api.put<Category>(`/admin/categories/${id}`, data);
}

export function deleteCategory(id: number): Promise<{ id: number }> {
  return api.del<{ id: number }>(`/admin/categories/${id}`);
}
