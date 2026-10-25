import { PrismaClient, Prisma, Contact } from '@prisma/client';
import { createContactSchema, csvContactSchema } from '../validators/contact.validator';
import { AppError } from '../middleware/errorHandler';
import { z } from 'zod';

// Singleton pattern for Prisma Client (important for serverless environments)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Valid blood groups
const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

/**
 * Normalize and validate blood group
 * - Converts to uppercase (e.g., "a+" -> "A+")
 * - If not in valid list, returns "No Data"
 * - If empty/null, returns null
 */
function normalizeBloodGroup(bloodGroup: string | null | undefined): string | null {
  if (!bloodGroup || bloodGroup.trim() === '') {
    return null;
  }
  
  const normalized = bloodGroup.trim().toUpperCase();
  
  if (VALID_BLOOD_GROUPS.includes(normalized)) {
    return normalized;
  }
  
  return 'No Data';
}

export class ContactService {
  /**
   * Create a single contact
   */
  async createContact(data: z.infer<typeof createContactSchema>): Promise<Contact> {
    const validated = createContactSchema.parse(data);
    
    // Check for duplicate phone
    const existing = await prisma.contact.findUnique({
      where: { phone: validated.phone }
    });

    if (existing) {
      throw new AppError('Contact with this phone number already exists', 409, 'DUPLICATE_PHONE');
    }

    return prisma.contact.create({
      data: {
        name: validated.name,
        phone: validated.phone,
        bloodGroup: normalizeBloodGroup(validated.bloodGroup),
        lobby: validated.lobby || null,
        designation: validated.designation || null
      }
    });
  }

  /**
   * Update a single contact
   */
  async updateContact(
    id: string,
    data: Partial<z.infer<typeof createContactSchema>>
  ): Promise<Contact> {
    // Check if contact exists
    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Contact not found', 404, 'NOT_FOUND');
    }

    // If phone is being updated, check for duplicates
    if (data.phone && data.phone !== existing.phone) {
      const phoneExists = await prisma.contact.findUnique({
        where: { phone: data.phone }
      });
      if (phoneExists) {
        throw new AppError('Contact with this phone number already exists', 409, 'DUPLICATE_PHONE');
      }
    }

    return prisma.contact.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.phone && { phone: data.phone }),
        ...(data.bloodGroup !== undefined && { bloodGroup: normalizeBloodGroup(data.bloodGroup) }),
        ...(data.lobby !== undefined && { lobby: data.lobby || null }),
        ...(data.designation !== undefined && { designation: data.designation || null })
      }
    });
  }

  /**
   * Delete a single contact
   */
  async deleteContact(id: string): Promise<void> {
    const contact = await prisma.contact.findUnique({ where: { id } });
    if (!contact) {
      throw new AppError('Contact not found', 404, 'NOT_FOUND');
    }

    await prisma.contact.delete({ where: { id } });
  }

  /**
   * Delete all contacts
   */
  async deleteAllContacts(): Promise<{ count: number }> {
    return prisma.contact.deleteMany();
  }

  /**
   * Get all contacts with pagination
   */
  async getAllContacts(
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<Contact>> {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        skip,
        take: limit,
        orderBy: { name: 'asc' }
      }),
      prisma.contact.count()
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get all contacts without pagination
   */
  async getAllContactsWithoutPagination(): Promise<Contact[]> {
    return prisma.contact.findMany({
      orderBy: { name: 'asc' }
    });
  }

  /**
   * Search contacts by name (partial, case/spacing/punctuation-insensitive)
   */
  async searchByName(
    query: string,
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<Contact>> {
    const skip = (page - 1) * limit;

    // Normalize both operands in PostgreSQL, so dots, spaces and punctuation
    // do not make initials or partial names harder to find. Parameterized SQL
    // keeps user input literal; strpos avoids LIKE wildcard expansion.
    const normalizedQuery = Prisma.sql`regexp_replace(lower(${query}::text), '[^[:alnum:]]', '', 'g')`;
    const normalizedName = Prisma.sql`regexp_replace(lower("name"), '[^[:alnum:]]', '', 'g')`;
    const where = Prisma.sql`length(${normalizedQuery}) > 0 AND strpos(${normalizedName}, ${normalizedQuery}) > 0`;
    const [data, counts] = await Promise.all([
      prisma.$queryRaw<Contact[]>(Prisma.sql`
        SELECT * FROM "contacts" WHERE ${where}
        ORDER BY "name" ASC, "id" ASC LIMIT ${limit} OFFSET ${skip}
      `),
      prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COUNT(*) AS total FROM "contacts" WHERE ${where}
      `)
    ]);
    const total = Number(counts[0]?.total ?? 0);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Search contacts by phone (partial match, user-friendly like mobile contact search)
   * Normalizes phone numbers by removing formatting characters for better matching
   */
  async searchByPhone(query: string): Promise<Contact[]> {
    // Normalize query: remove spaces, dashes, and other formatting characters for phone search
    const normalizedQuery = query.replace(/[\s\-\(\)\.]/g, '');
    
    // Search phone with both normalized and original query to handle different formats
    const whereClause = {
      OR: [
        {
          phone: {
            contains: normalizedQuery,
            mode: 'insensitive' as const
          }
        },
        {
          phone: {
            contains: query,
            mode: 'insensitive' as const
          }
        }
      ]
    };

    return prisma.contact.findMany({
      where: whereClause,
      orderBy: { phone: 'asc' }
    });
  }

  /**
   * Get total count of contacts
   */
  async getTotalCount(): Promise<number> {
    return prisma.contact.count();
  }

  /**
   * Get contacts by blood group(s) and/or lobby(s) with pagination
   * @param bloodGroups - Optional: Single blood group or array of blood groups
   * @param page - Page number
   * @param limit - Records per page
   * @param lobbies - Optional: Single lobby or array of lobbies to filter by
   */
  async getContactsByBloodGroup(
    bloodGroups?: string | string[],
    page: number = 1,
    limit: number = 50,
    lobbies?: string | string[]
  ): Promise<PaginatedResult<Contact>> {
    // Normalize blood groups to array (if provided)
    let normalizedBloodGroups: string[] | undefined;
    if (bloodGroups) {
      const bloodGroupArray = Array.isArray(bloodGroups) ? bloodGroups : [bloodGroups];
      normalizedBloodGroups = bloodGroupArray
        .map(bg => bg.trim().toUpperCase())
        .filter(bg => bg !== '');
      
      if (normalizedBloodGroups.length === 0) {
        normalizedBloodGroups = undefined;
      }
    }

    // Normalize lobbies to array (if provided)
    let normalizedLobbies: string[] | undefined;
    if (lobbies) {
      const lobbyArray = Array.isArray(lobbies) ? lobbies : [lobbies];
      normalizedLobbies = lobbyArray
        .map(lobby => lobby.trim())
        .filter(lobby => lobby !== '');
      
      if (normalizedLobbies.length === 0) {
        normalizedLobbies = undefined;
      }
    }

    // At least one filter must be provided
    if (!normalizedBloodGroups && !normalizedLobbies) {
      throw new AppError('At least one of bloodGroup or lobby is required', 400, 'MISSING_FILTER');
    }

    const skip = (page - 1) * limit;

    // Build where clause for case-insensitive matching
    // Filter by bloodGroup AND/OR lobby based on what's provided
    const whereConditions: any[] = [];

    // Add blood group filter if provided
    if (normalizedBloodGroups && normalizedBloodGroups.length > 0) {
      whereConditions.push({
        OR: normalizedBloodGroups.map(bg => ({
          bloodGroup: {
            equals: bg,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Add lobby filter if provided
    if (normalizedLobbies && normalizedLobbies.length > 0) {
      whereConditions.push({
        OR: normalizedLobbies.map(lobby => ({
          lobby: {
            equals: lobby,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Build final where clause
    const where: any = whereConditions.length > 0 ? { AND: whereConditions } : {};

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: 'asc' }
      }),
      prisma.contact.count({ where })
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get all unique blood groups (case-insensitive)
   */
  async getAllBloodGroups(): Promise<string[]> {
    // Get all contacts with blood groups
    const contacts = await prisma.contact.findMany({
      select: {
        bloodGroup: true
      },
      where: {
        bloodGroup: {
          not: null
        }
      }
    });

    // Extract blood groups, normalize to uppercase, filter out nulls and empty strings
    const bloodGroupsMap = new Map<string, string>();
    
    contacts.forEach(contact => {
      if (contact.bloodGroup && contact.bloodGroup.trim() !== '') {
        const normalized = contact.bloodGroup.trim().toUpperCase();
        // Store the normalized version (use first occurrence's original case if needed, 
        // but we'll return uppercase for consistency)
        bloodGroupsMap.set(normalized, normalized);
      }
    });

    // Convert to array, sort, and return
    return Array.from(bloodGroupsMap.values()).sort();
  }

  /**
   * Get contacts by lobby(s) and/or designation(s) with pagination
   * @param lobbies - Optional: Single lobby or array of lobbies
   * @param page - Page number
   * @param limit - Records per page
   * @param designations - Optional: Single designation or array of designations to filter by
   */
  async getContactsByLobby(
    lobbies?: string | string[],
    page: number = 1,
    limit: number = 50,
    designations?: string | string[]
  ): Promise<PaginatedResult<Contact>> {
    // Normalize lobbies to array (if provided)
    let normalizedLobbies: string[] | undefined;
    if (lobbies) {
      const lobbyArray = Array.isArray(lobbies) ? lobbies : [lobbies];
      normalizedLobbies = lobbyArray
        .map(lobby => lobby.trim())
        .filter(lobby => lobby !== '');
      
      if (normalizedLobbies.length === 0) {
        normalizedLobbies = undefined;
      }
    }

    // Normalize designations to array (if provided)
    let normalizedDesignations: string[] | undefined;
    if (designations) {
      const designationArray = Array.isArray(designations) ? designations : [designations];
      normalizedDesignations = designationArray
        .map(designation => designation.trim())
        .filter(designation => designation !== '');
      
      if (normalizedDesignations.length === 0) {
        normalizedDesignations = undefined;
      }
    }

    // At least one filter must be provided
    if (!normalizedLobbies && !normalizedDesignations) {
      throw new AppError('At least one of lobby or designation is required', 400, 'MISSING_FILTER');
    }

    const skip = (page - 1) * limit;

    // Build where clause for case-insensitive matching
    // Filter by lobby AND/OR designation based on what's provided
    const whereConditions: any[] = [];

    // Add lobby filter if provided
    if (normalizedLobbies && normalizedLobbies.length > 0) {
      whereConditions.push({
        OR: normalizedLobbies.map(lobby => ({
          lobby: {
            equals: lobby,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Add designation filter if provided
    if (normalizedDesignations && normalizedDesignations.length > 0) {
      whereConditions.push({
        OR: normalizedDesignations.map(designation => ({
          designation: {
            equals: designation,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Build final where clause
    const where: any = whereConditions.length > 0 ? { AND: whereConditions } : {};

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: 'asc' }
      }),
      prisma.contact.count({ where })
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get all unique lobbies (case-insensitive)
   */
  async getAllLobbies(): Promise<string[]> {
    // Get all contacts with lobbies
    const contacts = await prisma.contact.findMany({
      select: {
        lobby: true
      },
      where: {
        lobby: {
          not: null
        }
      }
    });

    // Extract lobbies, normalize case-insensitively, filter out nulls and empty strings
    const lobbiesMap = new Map<string, string>();
    
    contacts.forEach(contact => {
      if (contact.lobby && contact.lobby.trim() !== '') {
        const normalized = contact.lobby.trim();
        // Use lowercase as key for case-insensitive deduplication
        const key = normalized.toLowerCase();
        // Store the first occurrence's original case
        if (!lobbiesMap.has(key)) {
          lobbiesMap.set(key, normalized);
        }
      }
    });

    // Convert to array, sort, and return
    return Array.from(lobbiesMap.values()).sort();
  }

  /**
   * Get contacts with unified filters (bloodGroup, lobby, designation)
   * @param filters - Filter object with optional bloodGroup, lobby, and designation
   * @param page - Page number
   * @param limit - Records per page
   */
  async filterContacts(
    filters: {
      bloodGroup?: string | string[];
      lobby?: string | string[];
      designation?: string | string[];
    },
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<Contact>> {
    // Normalize blood groups to array (if provided)
    let normalizedBloodGroups: string[] | undefined;
    if (filters.bloodGroup) {
      const bloodGroupArray = Array.isArray(filters.bloodGroup) ? filters.bloodGroup : [filters.bloodGroup];
      normalizedBloodGroups = bloodGroupArray
        .map(bg => bg.trim().toUpperCase())
        .filter(bg => bg !== '');
      
      if (normalizedBloodGroups.length === 0) {
        normalizedBloodGroups = undefined;
      }
    }

    // Normalize lobbies to array (if provided)
    let normalizedLobbies: string[] | undefined;
    if (filters.lobby) {
      const lobbyArray = Array.isArray(filters.lobby) ? filters.lobby : [filters.lobby];
      normalizedLobbies = lobbyArray
        .map(lobby => lobby.trim())
        .filter(lobby => lobby !== '');
      
      if (normalizedLobbies.length === 0) {
        normalizedLobbies = undefined;
      }
    }

    // Normalize designations to array (if provided)
    let normalizedDesignations: string[] | undefined;
    if (filters.designation) {
      const designationArray = Array.isArray(filters.designation) ? filters.designation : [filters.designation];
      normalizedDesignations = designationArray
        .map(designation => designation.trim())
        .filter(designation => designation !== '');
      
      if (normalizedDesignations.length === 0) {
        normalizedDesignations = undefined;
      }
    }

    // At least one filter must be provided
    if (!normalizedBloodGroups && !normalizedLobbies && !normalizedDesignations) {
      throw new AppError('At least one filter (bloodGroup, lobby, or designation) is required', 400, 'MISSING_FILTER');
    }

    const skip = (page - 1) * limit;

    // Build where clause for case-insensitive matching
    // All provided filters use AND logic (contact must match all specified filters)
    const whereConditions: any[] = [];

    // Add blood group filter if provided
    if (normalizedBloodGroups && normalizedBloodGroups.length > 0) {
      whereConditions.push({
        OR: normalizedBloodGroups.map(bg => ({
          bloodGroup: {
            equals: bg,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Add lobby filter if provided
    if (normalizedLobbies && normalizedLobbies.length > 0) {
      whereConditions.push({
        OR: normalizedLobbies.map(lobby => ({
          lobby: {
            equals: lobby,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Add designation filter if provided
    if (normalizedDesignations && normalizedDesignations.length > 0) {
      whereConditions.push({
        OR: normalizedDesignations.map(designation => ({
          designation: {
            equals: designation,
            mode: 'insensitive' as const
          }
        }))
      });
    }

    // Build final where clause
    const where: any = whereConditions.length > 0 ? { AND: whereConditions } : {};

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: 'asc' }
      }),
      prisma.contact.count({ where })
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get all unique designations (case-insensitive)
   */
  async getAllDesignations(): Promise<string[]> {
    // Get all contacts with designations
    const contacts = await prisma.contact.findMany({
      select: {
        designation: true
      },
      where: {
        designation: {
          not: null
        }
      }
    });

    // Extract designations, normalize case-insensitively, filter out nulls and empty strings
    const designationsMap = new Map<string, string>();
    
    contacts.forEach(contact => {
      if (contact.designation && contact.designation.trim() !== '') {
        const normalized = contact.designation.trim();
        // Use lowercase as key for case-insensitive deduplication
        const key = normalized.toLowerCase();
        // Store the first occurrence's original case
        if (!designationsMap.has(key)) {
          designationsMap.set(key, normalized);
        }
      }
    });

    // Convert to array, sort, and return
    return Array.from(designationsMap.values()).sort();
  }

  /**
   * Analytics: Get overview statistics
   */
  async getAnalyticsOverview() {
    const [
      totalContacts,
      contactsWithBloodGroup,
      contactsWithLobby,
      recentContacts7Days,
      recentContacts30Days,
      visitCount
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { bloodGroup: { not: null } } }),
      prisma.contact.count({ where: { lobby: { not: null } } }),
      prisma.contact.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      prisma.contact.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      this.getVisitCount()
    ]);

    return {
      totalContacts,
      contactsWithBloodGroup,
      contactsWithLobby,
      contactsWithoutBloodGroup: totalContacts - contactsWithBloodGroup,
      contactsWithoutLobby: totalContacts - contactsWithLobby,
      recentContacts7Days,
      recentContacts30Days,
      visitCount,
      bloodGroupCoverage: totalContacts > 0 ? ((contactsWithBloodGroup / totalContacts) * 100).toFixed(2) : '0.00',
      lobbyCoverage: totalContacts > 0 ? ((contactsWithLobby / totalContacts) * 100).toFixed(2) : '0.00'
    };
  }

  /**
   * Analytics: Get blood group distribution
   */
  async getBloodGroupDistribution() {
    const contacts = await prisma.contact.findMany({
      select: {
        bloodGroup: true
      },
      where: {
        bloodGroup: {
          not: null
        }
      }
    });

    const distribution = new Map<string, number>();
    
    contacts.forEach(contact => {
      if (contact.bloodGroup) {
        const normalized = contact.bloodGroup.trim().toUpperCase();
        distribution.set(normalized, (distribution.get(normalized) || 0) + 1);
      }
    });

    const total = contacts.length;
    const result = Array.from(distribution.entries())
      .map(([bloodGroup, count]) => ({
        bloodGroup,
        count,
        percentage: total > 0 ? ((count / total) * 100).toFixed(2) : '0.00'
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      distribution: result
    };
  }

  /**
   * Analytics: Get lobby distribution
   */
  async getLobbyDistribution() {
    const contacts = await prisma.contact.findMany({
      select: {
        lobby: true
      },
      where: {
        lobby: {
          not: null
        }
      }
    });

    const distribution = new Map<string, { count: number; label: string }>();
    
    contacts.forEach(contact => {
      if (contact.lobby) {
        const normalized = contact.lobby.trim();
        const key = normalized.toLowerCase();
        if (!distribution.has(key)) {
          distribution.set(key, { count: 0, label: normalized });
        }
        const entry = distribution.get(key);
        if (entry) {
          entry.count++;
        }
      }
    });

    const total = contacts.length;
    const result = Array.from(distribution.values())
      .map(({ label, count }) => ({
        lobby: label,
        count,
        percentage: total > 0 ? ((count / total) * 100).toFixed(2) : '0.00'
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      distribution: result
    };
  }


  /**
   * Analytics: Get designation distribution
   */
  async getDesignationDistribution() {
    const contacts = await prisma.contact.findMany({
      select: {
        designation: true
      },
      where: {
        designation: {
          not: null
        }
      }
    });

    const distribution = new Map<string, { count: number; label: string }>();
    
    contacts.forEach(contact => {
      if (contact.designation) {
        const normalized = contact.designation.trim();
        const key = normalized.toLowerCase();
        if (!distribution.has(key)) {
          distribution.set(key, { count: 0, label: normalized });
        }
        const entry = distribution.get(key);
        if (entry) {
          entry.count++;
        }
      }
    });

    const total = contacts.length;
    const result = Array.from(distribution.values())
      .map(({ label, count }) => ({
        designation: label,
        count,
        percentage: total > 0 ? ((count / total) * 100).toFixed(2) : '0.00'
      }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      distribution: result
    };
  }

  /**
   * Analytics: Get contacts growth over time
   */
  async getContactsGrowth(days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const contacts = await prisma.contact.findMany({
      select: {
        createdAt: true
      },
      where: {
        createdAt: {
          gte: startDate
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    // Group by date
    const dailyGrowth = new Map<string, number>();
    
    contacts.forEach(contact => {
      const date = contact.createdAt.toISOString().split('T')[0];
      dailyGrowth.set(date, (dailyGrowth.get(date) || 0) + 1);
    });

    // Fill in missing dates with 0
    const result: Array<{ date: string; count: number; cumulative: number }> = [];
    let cumulative = 0;
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const count = dailyGrowth.get(dateStr) || 0;
      cumulative += count;
      
      result.push({
        date: dateStr,
        count,
        cumulative
      });
    }

    return {
      period: `${days} days`,
      totalAdded: contacts.length,
      dailyGrowth: result
    };
  }

  /**
   * Analytics: Get recent contacts
   */
  async getRecentContacts(limit: number = 10) {
    const contacts = await prisma.contact.findMany({
      take: limit,
      orderBy: {
        createdAt: 'desc'
      },
      select: {
        id: true,
        name: true,
        phone: true,
        bloodGroup: true,
        lobby: true,
        designation: true,
        createdAt: true
      }
    });

    return {
      count: contacts.length,
      contacts
    };
  }

  /**
   * Analytics: Increment and get visit count (thread-safe)
   * Also records daily visit history for charting
   */
  async incrementVisitCount(): Promise<number> {
    try {
      // Use upsert with atomic increment to handle concurrent requests
      // This ensures thread-safety even when multiple users hit the API simultaneously
      const result = await prisma.visitCount.upsert({
        where: { id: 'singleton' },
        update: {
          count: {
            increment: 1
          }
        },
        create: {
          id: 'singleton',
          count: 1
        }
      });

      // Record daily visit history (non-blocking, won't break if it fails)
      this.recordDailyVisitHistory().catch(err => {
        console.error('Failed to record visit history:', err);
        // Don't throw - this is a non-critical operation
      });

      return result.count;
    } catch (error) {
      // If upsert fails, try to create or increment separately
      try {
        // Try to increment first
        const updated = await prisma.visitCount.update({
          where: { id: 'singleton' },
          data: {
            count: {
              increment: 1
            }
          }
        });
        
        // Record daily visit history (non-blocking)
        this.recordDailyVisitHistory().catch(err => {
          console.error('Failed to record visit history:', err);
        });
        
        return updated.count;
      } catch (updateError) {
        // If update fails (record doesn't exist), create it
        const created = await prisma.visitCount.create({
          data: {
            id: 'singleton',
            count: 1
          }
        });
        
        // Record daily visit history (non-blocking)
        this.recordDailyVisitHistory().catch(err => {
          console.error('Failed to record visit history:', err);
        });
        
        return created.count;
      }
    }
  }

  /**
   * Record daily visit history (internal helper method)
   * Non-blocking - failures won't affect the main increment operation
   */
  private async recordDailyVisitHistory(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Set to start of day

      // Upsert today's visit count (increment if exists, create if not)
      await prisma.visitHistory.upsert({
        where: { date: today },
        update: {
          count: {
            increment: 1
          }
        },
        create: {
          date: today,
          count: 1
        }
      });
    } catch (error) {
      // Silently fail - this is a non-critical operation
      // The main visit count increment should still succeed
      console.error('Error recording visit history:', error);
    }
  }

  /**
   * Analytics: Get visit count without incrementing
   */
  async getVisitCount(): Promise<number> {
    const visitCount = await prisma.visitCount.findUnique({
      where: { id: 'singleton' }
    });

    return visitCount?.count || 0;
  }

  /**
   * Analytics: Get visit history for charting
   * Returns daily visit counts for the specified number of days
   */
  async getVisitHistory(days: number = 30): Promise<Array<{ date: string; count: number }>> {
    // Calculate start date
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    // Get all visit history records from start date to today
    const history = await prisma.visitHistory.findMany({
      where: {
        date: {
          gte: startDate
        }
      },
      orderBy: {
        date: 'asc'
      }
    });

    // Create a map of existing records for quick lookup
    const historyMap = new Map<string, number>();
    history.forEach(record => {
      const dateStr = record.date.toISOString().split('T')[0];
      historyMap.set(dateStr, record.count);
    });

    // Fill in missing dates with 0 and format response
    const result: Array<{ date: string; count: number }> = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < days; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      const dateStr = currentDate.toISOString().split('T')[0];

      result.push({
        date: dateStr,
        count: historyMap.get(dateStr) || 0
      });
    }

    return result;
  }

  /**
   * Bulk upload contacts from CSV data
   */
  async bulkUploadContacts(
    contacts: Array<z.infer<typeof csvContactSchema>>,
    replaceAll: boolean = false
  ): Promise<{ 
    created: number; 
    errors: Array<{ 
      row: number; 
      error: string;
      type: string;
      field?: string;
    }>;
    report: {
      total: number;
      created: number;
      failed: number;
      errorsByType: Record<string, number>;
      errorsByField: Record<string, number>;
      connectionLost?: boolean;
      partialUpload?: boolean;
      processedContacts?: number;
      notProcessedContacts?: number;
      message?: string;
    };
  }> {
    // If replaceAll is true, delete all existing contacts first
    if (replaceAll) {
      await prisma.contact.deleteMany();
    }

    const errors: Array<{ 
      row: number; 
      error: string;
      type: string;
      field?: string;
    }> = [];
    const validContacts: Array<z.infer<typeof csvContactSchema>> = [];
    const phoneSet = new Set<string>();

    // Helper function to parse Zod errors into user-friendly messages
    const parseZodError = (error: z.ZodError): { message: string; field?: string; type: string } => {
      // Check if issues array exists and has elements (ZodError uses 'issues', not 'errors')
      if (!error.issues || !Array.isArray(error.issues) || error.issues.length === 0) {
        return {
          message: 'Validation failed',
          type: 'validation_error'
        };
      }

      const firstError = error.issues[0];
      
      // Check if firstError exists and has required properties
      if (!firstError) {
        return {
          message: 'Validation failed',
          type: 'validation_error'
        };
      }

      let message = firstError.message || 'Validation failed';
      const field = (firstError.path && Array.isArray(firstError.path)) 
        ? firstError.path.join('.') 
        : '';
      
      // Make error messages more user-friendly
      const errorCode = firstError.code as string;
      if (errorCode === 'too_small') {
        message = `${field ? `${field}: ` : ''}Value is too short`;
      } else if (errorCode === 'too_big') {
        message = `${field ? `${field}: ` : ''}Value is too long`;
      } else if (errorCode === 'invalid_type') {
        message = `${field ? `${field}: ` : ''}Invalid value type`;
      } else if (errorCode === 'invalid_string' || errorCode === 'invalid_format') {
        message = `${field ? `${field}: ` : ''}Invalid format`;
      }
      
      return {
        message,
        field: field || undefined,
        type: firstError.code || 'validation_error'
      };
    };

    // Validate and deduplicate contacts
    contacts.forEach((contact, index) => {
      try {
        const validated = csvContactSchema.parse(contact);
        
        // Check for duplicates within the batch
        if (phoneSet.has(validated.phone)) {
          errors.push({
            row: index + 1,
            error: `Duplicate phone number in CSV: ${validated.phone}`,
            type: 'duplicate',
            field: 'phone'
          });
          return;
        }

        phoneSet.add(validated.phone);
        validContacts.push(validated);
      } catch (error) {
        if (error instanceof z.ZodError) {
          const parsed = parseZodError(error);
          errors.push({
            row: index + 1,
            error: parsed.message,
            type: parsed.type,
            field: parsed.field
          });
        } else {
          let errorMessage = 'Validation failed';
          if (error instanceof Error) {
            // Sanitize error message to remove file paths
            errorMessage = error.message
              .replace(/[A-Z]:\\[^\s]+/gi, '')
              .replace(/\/[^\s]+\.(ts|js)/g, '')
              .trim() || 'Validation failed';
          }
          errors.push({
            row: index + 1,
            error: errorMessage,
            type: 'validation_error'
          });
        }
      }
    });

    // Generate error report
    const errorsByType: Record<string, number> = {};
    const errorsByField: Record<string, number> = {};
    
    errors.forEach(err => {
      errorsByType[err.type] = (errorsByType[err.type] || 0) + 1;
      if (err.field) {
        errorsByField[err.field] = (errorsByField[err.field] || 0) + 1;
      }
    });

    const report = {
      total: contacts.length,
      created: 0,
      failed: errors.length,
      errorsByType,
      errorsByField
    };

    if (validContacts.length === 0) {
      return { created: 0, errors, report };
    }

    // Prepare data for bulk insert
    const dataToInsert = validContacts.map(contact => ({
      name: contact.name,
      phone: contact.phone,
      bloodGroup: normalizeBloodGroup(contact.bloodGroup),
      lobby: contact.lobby || null,
      designation: contact.designation || null
    }));

    // Optimize bulk insertion based on replaceAll flag
    try {
      if (replaceAll) {
        // If replacing all, we can use createMany with skipDuplicates for better performance
        // Since we already deleted all records, duplicates only exist within the batch
        const result = await prisma.contact.createMany({
          data: dataToInsert,
          skipDuplicates: true
        });
        report.created = result.count;
        return {
          created: result.count,
          errors,
          report
        };
      } else {
        // For incremental updates, use upsert in batches for better performance
        // Process in chunks of 500 to avoid transaction timeout
        const chunkSize = 500;
        let created = 0;
        let lastSuccessfulChunk = -1;
        let connectionLost = false;
        
        for (let i = 0; i < dataToInsert.length; i += chunkSize) {
          const chunk = dataToInsert.slice(i, i + chunkSize);
          try {
            await prisma.$transaction(
              chunk.map(data =>
                prisma.contact.upsert({
                  where: { phone: data.phone },
                  update: data,
                  create: data
                })
              )
            );
            created += chunk.length;
            lastSuccessfulChunk = i;
          } catch (chunkError: any) {
            // Check if it's a connection/timeout error
            if (
              chunkError?.code === 'P1001' || // Connection timeout
              chunkError?.code === 'P1008' || // Transaction timeout
              chunkError?.message?.includes('timeout') ||
              chunkError?.message?.includes('connection') ||
              chunkError?.message?.includes('ECONNRESET') ||
              chunkError?.message?.includes('ETIMEDOUT')
            ) {
              connectionLost = true;
              // Mark remaining contacts as not processed due to connection loss
              // We don't add individual errors for each contact to avoid bloating the response
              // Instead, we'll report the count in the report message
              // Break out of loop - connection is lost
              break;
            } else {
              // Other error - try individual inserts for this chunk
              for (const data of chunk) {
                try {
                  await prisma.contact.upsert({
                    where: { phone: data.phone },
                    update: data,
                    create: data
                  });
                  created++;
                } catch (err: any) {
                  const originalIndex = validContacts.findIndex(
                    vc => vc.phone === data.phone
                  );
                  let errorMessage = 'Insert failed';
                  let errorType = 'insert_error';
                  if (err instanceof Error) {
                    errorMessage = err.message
                      .replace(/[A-Z]:\\[^\s]+/gi, '')
                      .replace(/\/[^\s]+\.(ts|js)/g, '')
                      .trim() || 'Insert failed';
                    if (err.message.includes('Unique constraint') || err.message.includes('P2002')) {
                      errorMessage = 'Phone number already exists in database';
                      errorType = 'duplicate';
                    }
                  }
                  errors.push({
                    row: originalIndex >= 0 ? contacts.indexOf(validContacts[originalIndex]) + 1 : i + 1,
                    error: errorMessage,
                    type: errorType,
                    field: 'phone'
                  });
                }
              }
            }
          }
        }

        report.created = created;
        
        // If connection was lost, add warning to report
        if (connectionLost) {
          const remainingContacts = dataToInsert.length - created;
          const processedContacts = created;
          const notProcessed = remainingContacts;
          
          // Recalculate error statistics including connection errors
          const updatedErrorsByType: Record<string, number> = { ...errorsByType };
          updatedErrorsByType['connection_error'] = (updatedErrorsByType['connection_error'] || 0) + notProcessed;
          
          report.failed = errors.length + notProcessed;
          report.errorsByType = updatedErrorsByType;
          
          return {
            created: processedContacts,
            errors: [
              ...errors,
              {
                row: -1, // Special marker for connection error summary
                error: `Connection lost during upload. ${processedContacts} contacts uploaded successfully. ${notProcessed} contacts were not processed.`,
                type: 'connection_error'
              }
            ],
            report: {
              ...report,
              connectionLost: true,
              partialUpload: true,
              processedContacts,
              notProcessedContacts: notProcessed,
              message: `Connection lost during upload. ${processedContacts} contacts uploaded successfully. ${notProcessed} contacts were not processed. You can safely retry the upload - already uploaded contacts will be updated, not duplicated.`
            }
          };
        }

        return {
          created,
          errors,
          report
        };
      }
    } catch (error) {
      // Fallback: try individual inserts for better error reporting
      let created = 0;
      for (let i = 0; i < dataToInsert.length; i++) {
        try {
          await prisma.contact.upsert({
            where: { phone: dataToInsert[i].phone },
            update: dataToInsert[i],
            create: dataToInsert[i]
          });
          created++;
        } catch (err) {
          const originalIndex = validContacts.findIndex(
            vc => vc.phone === dataToInsert[i].phone
          );
          let errorMessage = 'Insert failed';
          let errorType = 'insert_error';
          if (err instanceof Error) {
            // Sanitize error message
            errorMessage = err.message
              .replace(/[A-Z]:\\[^\s]+/gi, '')
              .replace(/\/[^\s]+\.(ts|js)/g, '')
              .trim() || 'Insert failed';
            // Check for duplicate phone error
            if (err.message.includes('Unique constraint') || err.message.includes('P2002')) {
              errorMessage = 'Phone number already exists in database';
              errorType = 'duplicate';
            }
          }
          errors.push({
            row: originalIndex >= 0 ? contacts.indexOf(validContacts[originalIndex]) + 1 : i + 1,
            error: errorMessage,
            type: errorType,
            field: 'phone'
          });
        }
      }
      report.created = created;
      report.failed = errors.length;
      // Recalculate error statistics
      const updatedErrorsByType: Record<string, number> = {};
      const updatedErrorsByField: Record<string, number> = {};
      errors.forEach(err => {
        updatedErrorsByType[err.type] = (updatedErrorsByType[err.type] || 0) + 1;
        if (err.field) {
          updatedErrorsByField[err.field] = (updatedErrorsByField[err.field] || 0) + 1;
        }
      });
      report.errorsByType = updatedErrorsByType;
      report.errorsByField = updatedErrorsByField;
      return { created, errors, report };
    }
  }
}

export const contactService = new ContactService();

