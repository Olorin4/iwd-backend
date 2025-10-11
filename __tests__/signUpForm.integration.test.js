import { signUpForm } from '../src/formsController';
import { prisma } from '../src/prismaClient';
import { validationResult } from 'express-validator';
import * as emailService from '../src/emailService';

jest.mock('../src/emailService', () => ({
  emailClient: jest.fn(),
  emailAdmin: jest.fn(),
}));

describe('signUpForm - Integration', () => {
  let req, res;

  beforeEach(async () => {
    req = {
      body: {
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane.doe@example.com',
        phone: '0987654321',
        fleet_size: '10',
        trailer_type: 'Reefer',
        plan: 'Basic',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    // Clear the database before each test
    await prisma.signUpForm.deleteMany();
  });

  afterAll(async () => {
    // Disconnect Prisma after all tests
    await prisma.$disconnect();
  });

  it('should save valid form data to the database', async () => {
    await signUpForm(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Form submitted successfully!',
      })
    );

    // Retrieve the saved data directly from the database
    const savedData = await prisma.signUpForm.findFirst({
      where: { email: 'jane.doe@example.com' },
    });

    expect(savedData).toBeTruthy();
    expect(savedData.first_name).toBe('Jane');
    expect(savedData.email).toBe('jane.doe@example.com');
    expect(savedData.status).toBe('pending');
  });

  it('should return a 400 error if required fields are missing', async () => {
    delete req.body.first_name;
    await signUpForm(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'All fields are required.',
    });
  });
});